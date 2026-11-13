//! The agent's main loop: say hello, report live usage, and take jobs from the server one long poll at a time,
//! running up to `jobs.slots` at once. `supervise` keeps it going for the tray app: it waits for a pairing, runs the
//! loop with it, and starts again when the pairing changes.
const std = @import("std");
const Io = std.Io;
const Api = @import("api.zig").Api;
const cpu = @import("cpu.zig");
const job = @import("job.zig");
const jobs = @import("jobs.zig");
const log = @import("log.zig");
const machine = @import("machine.zig");
const sess = @import("session.zig");
const Session = sess.Session;

const stats_busy_ms = 3000;
const stats_idle_ms = 15000;
const hello_every_ms = 10 * 60 * 1000;

const JobStat = struct { task: []const u8, phase: ?[]const u8, progress: ?f64 };
const Stats = struct {
    cpu: ?f64,
    coresBusy: ?f64,
    cores: u32,
    memUsedGb: ?f64,
    memTotalGb: f64,
    jobs: []const JobStat,
};

fn statsLoop(ctx: *job.Ctx, info: *const machine.Info, session: *Session, generation: u64) void {
    const io = ctx.io;
    var api = Api.init(ctx.gpa, io, ctx.server, ctx.token);
    defer api.deinit();
    var sampler: cpu.Sampler = .{};
    _ = sampler.sample(io);
    var since_hello: u64 = 0;
    var first = true;
    while (true) {
        const busy = ctx.table.count(io) > 0;
        // The first report goes out soon after start, so the profile shows the computer's load right away.
        const wait: u64 = if (busy or first) stats_busy_ms else stats_idle_ms;
        first = false;
        io.sleep(.fromMilliseconds(@intCast(wait)), .awake) catch return;
        if (session.changed(generation)) return;
        since_hello += wait;
        if (since_hello >= hello_every_ms) {
            since_hello = 0;
            if (api.post("/local-worker/hello", .{ .info = info.* })) |r| r.deinit(ctx.gpa) else |err| log.say(io, "hello not sent ({s})", .{@errorName(err)});
        }
        var list: [jobs.slots]JobStat = undefined;
        var snaps: [jobs.slots]jobs.Entry = undefined;
        var n: usize = 0;
        for (0..jobs.slots) |i| {
            snaps[i] = ctx.table.snapshot(io, i);
            const e = &snaps[i];
            if (!e.used) continue;
            list[n] = .{ .task = e.task[0..e.task_len], .phase = if (e.phase_len > 0) e.phase[0..e.phase_len] else null, .progress = e.progress };
            n += 1;
        }
        const busy_pct = sampler.sample(io);
        const mem = machine.memory(io);
        const stats: Stats = .{
            .cpu = busy_pct,
            .coresBusy = if (busy_pct) |p| p / 100.0 * @as(f64, @floatFromInt(info.cpuThreads)) else null,
            .cores = info.cpuThreads,
            .memUsedGb = if (mem.available) |a| machine.gb(mem.total -| a) else null,
            .memTotalGb = machine.gb(mem.total),
            .jobs = list[0..n],
        };
        if (api.post("/local-worker/stats", .{ .stats = stats })) |r| r.deinit(ctx.gpa) else |err| if (ctx.verbose) log.say(io, "stats not sent ({s})", .{@errorName(err)});
    }
}

const NextJob = struct { id: []const u8, input: std.json.Value };

/// Takes jobs with `ctx`'s pairing until the server refuses it (`error.NotPaired`, `error.Outdated`) or the session's
/// pairing changes (`error.Restart`). The server not being reached is not an error: the loop keeps trying.
pub fn serve(ctx: *job.Ctx, info: *const machine.Info, session: *Session, generation: u64) !void {
    const io = ctx.io;
    var api = Api.init(ctx.gpa, io, ctx.server, ctx.token);
    defer api.deinit();
    var backoff_ms: u64 = 0;
    // Hello first; while the server is not reached, keep trying.
    while (true) {
        if (session.changed(generation)) return error.Restart;
        const hello = api.post("/local-worker/hello", .{ .info = info.* }) catch |err| {
            if (err == error.NotPaired or err == error.Outdated) return err;
            backoff_ms = @min(30_000, if (backoff_ms == 0) 2000 else backoff_ms * 2);
            session.setStatus(io, .unreachable_server, @errorName(err));
            log.say(io, "server not reached ({s}); trying again in {d}s", .{ @errorName(err), backoff_ms / 1000 });
            io.sleep(.fromMilliseconds(@intCast(backoff_ms)), .awake) catch return;
            continue;
        };
        hello.deinit(ctx.gpa);
        break;
    }
    backoff_ms = 0;
    session.setStatus(io, .ready, "");
    log.say(io, "Direct360 Helper Agent {s} is running for {s}", .{ machine.version, ctx.server });

    const stats_thread = try std.Thread.spawn(.{}, statsLoop, .{ ctx, info, session, generation });
    stats_thread.detach();

    while (true) {
        if (session.changed(generation)) return error.Restart;
        if (ctx.active.load(.acquire) >= jobs.slots) {
            io.sleep(.fromMilliseconds(300), .awake) catch return;
            continue;
        }
        const r = api.get("/local-worker/jobs/next") catch |err| {
            if (err == error.NotPaired or err == error.Outdated) return err;
            backoff_ms = @min(30_000, if (backoff_ms == 0) 2000 else backoff_ms * 2);
            session.setStatus(io, .unreachable_server, @errorName(err));
            log.say(io, "server not reached ({s}); trying again in {d}s", .{ @errorName(err), backoff_ms / 1000 });
            io.sleep(.fromMilliseconds(@intCast(backoff_ms)), .awake) catch return;
            continue;
        };
        defer r.deinit(ctx.gpa);
        if (backoff_ms != 0) session.setStatus(io, .ready, "");
        backoff_ms = 0;
        if (r.status == 204 or r.body.len == 0) continue;
        var parsed = std.json.parseFromSlice(NextJob, ctx.gpa, r.body, .{ .ignore_unknown_fields = true }) catch |err| {
            log.say(io, "a job from the server could not be read ({s})", .{@errorName(err)});
            continue;
        };
        defer parsed.deinit();
        const id = try ctx.gpa.dupe(u8, parsed.value.id);
        const input = try std.json.Stringify.valueAlloc(ctx.gpa, parsed.value.input, .{});
        _ = ctx.active.fetchAdd(1, .acq_rel);
        const t = std.Thread.spawn(.{}, job.run, .{ ctx, id, input }) catch |err| {
            _ = ctx.active.fetchSub(1, .acq_rel);
            ctx.gpa.free(id);
            ctx.gpa.free(input);
            log.say(io, "job could not start ({s})", .{@errorName(err)});
            continue;
        };
        t.detach();
    }
}

fn waitForChange(io: Io, session: *Session, generation: u64) void {
    while (!session.changed(generation)) io.sleep(.fromMilliseconds(500), .awake) catch return;
}

/// The tray app's job loop: runs with the session's pairing, waits while there is none or the server refused this
/// version, and starts again whenever the pairing changes. Never returns.
pub fn supervise(base: *const job.Ctx, info: *const machine.Info, session: *Session) void {
    const io = base.io;
    while (true) {
        // One allocation per pairing, kept: job threads of an older pairing may still use their copy.
        const creds = session.creds(io, base.gpa) catch {
            io.sleep(.fromSeconds(1), .awake) catch return;
            continue;
        };
        if (creds.token.len == 0) {
            session.setStatus(io, .unpaired, "");
            waitForChange(io, session, creds.generation);
            continue;
        }
        session.setStatus(io, .starting, "");
        const ctx = base.gpa.create(job.Ctx) catch return;
        ctx.* = base.*;
        ctx.server = creds.server;
        ctx.token = creds.token;
        serve(ctx, info, session, creds.generation) catch |err| switch (err) {
            error.Restart => {},
            error.NotPaired => {
                log.say(io, "the server no longer knows this agent; connect again from the tray", .{});
                session.setStatus(io, .unpaired, "");
                waitForChange(io, session, creds.generation);
            },
            error.Outdated => {
                session.setStatus(io, .outdated, "");
                waitForChange(io, session, creds.generation);
            },
            else => {
                log.say(io, "the job loop stopped: {s}", .{@errorName(err)});
                session.setStatus(io, .stopped, @errorName(err));
                waitForChange(io, session, creds.generation);
            },
        };
    }
}
