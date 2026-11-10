//! Runs one job: worker/render.js with the job's input on stdin, its progress lines forwarded to the server,
//! a cancel from the server stopping its whole process tree, and its final output (or failure) reported back.
const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const Api = @import("api.zig").Api;
const jobs = @import("jobs.zig");
const log = @import("log.zig");

pub const Ctx = struct {
    gpa: std.mem.Allocator,
    io: Io,
    server: []const u8,
    token: []const u8,
    env: *const std.process.Environ.Map,
    node: []const u8,
    render_js: []const u8,
    gpu_stitch: bool,
    verbose: bool,
    table: *jobs.Table,
    active: *std.atomic.Value(u32),
};

const progress_every_ms = 3000;

/// render.js lines worth showing without --verbose: failures, stalls, retries and fallbacks.
pub fn notable(line: []const u8) bool {
    const words = [_][]const u8{ "error", "fail", "stall", "retr", "fallback", "restart", "refused", "denied", "timed out", "timeout", "not found", "missing" };
    var buf: [512]u8 = undefined;
    const lower = std.ascii.lowerString(buf[0..@min(buf.len, line.len)], line[0..@min(buf.len, line.len)]);
    for (words) |w| if (std.mem.indexOf(u8, lower, w) != null) return true;
    return false;
}

/// The job's input with the GPU stitch switched to the CPU when this computer has no gpu-stitch.
pub fn prepareInput(arena: std.mem.Allocator, input_json: []const u8, gpu_stitch: bool) !struct { json: []const u8, task: []const u8 } {
    var value = try std.json.parseFromSliceLeaky(std.json.Value, arena, input_json, .{});
    if (value != .object) return error.BadJobInput;
    const task = if (value.object.get("task")) |t| (if (t == .string) t.string else "render") else "render";
    if (value.object.get("stitch_engine")) |e| {
        if (e == .string and std.mem.eql(u8, e.string, "gpu") and !gpu_stitch) try value.object.put(arena, "stitch_engine", .{ .string = "cpu" });
    }
    return .{ .json = try std.json.Stringify.valueAlloc(arena, value, .{}), .task = task };
}

/// The last non-empty line of render.js's stdout, if it is a JSON object.
pub fn lastJsonLine(out: []const u8) ?[]const u8 {
    var it = std.mem.splitBackwardsScalar(u8, std.mem.trimEnd(u8, out, " \r\n\t"), '\n');
    const line = std.mem.trim(u8, it.first(), " \r\t");
    if (line.len == 0 or line[0] != '{') return null;
    return line;
}

const Shared = struct {
    ctx: *Ctx,
    slot: usize,
    id: []const u8,
    done: std.atomic.Value(bool) = .init(false),
    cancelled: std.atomic.Value(bool) = .init(false),
    pid: ?std.process.Child.Id = null,
    tail_mutex: Io.Mutex = .init,
    tail: [4000]u8 = undefined,
    tail_len: usize = 0,

    fn addTail(s: *Shared, line: []const u8) void {
        s.tail_mutex.lockUncancelable(s.ctx.io);
        defer s.tail_mutex.unlock(s.ctx.io);
        const piece_len = @min(line.len, s.tail.len - 1);
        if (s.tail_len + piece_len + 1 > s.tail.len) {
            const keep = s.tail.len / 2;
            std.mem.copyForwards(u8, s.tail[0..keep], s.tail[s.tail_len - keep .. s.tail_len]);
            s.tail_len = keep;
        }
        @memcpy(s.tail[s.tail_len .. s.tail_len + piece_len], line[0..piece_len]);
        s.tail[s.tail_len + piece_len] = '\n';
        s.tail_len += piece_len + 1;
    }

    /// The last three log lines, for the failure message.
    fn lastLines(s: *Shared, buf: []u8) []const u8 {
        s.tail_mutex.lockUncancelable(s.ctx.io);
        defer s.tail_mutex.unlock(s.ctx.io);
        const text = std.mem.trimEnd(u8, s.tail[0..s.tail_len], "\n");
        var start = text.len;
        var lines: usize = 0;
        while (start > 0 and lines < 3) : (start -= 1) {
            if (text[start - 1] == '\n') lines += 1;
            if (lines == 3) break;
        }
        const piece = text[start..];
        const n = @min(buf.len, piece.len);
        @memcpy(buf[0..n], piece[0..n]);
        std.mem.replaceScalar(u8, buf[0..n], '\n', '|');
        return buf[0..n];
    }
};

fn readStderr(s: *Shared, file: Io.File) void {
    const io = s.ctx.io;
    var buf: [64 * 1024]u8 = undefined;
    var reader = file.reader(io, &buf);
    var arena: std.heap.ArenaAllocator = .init(s.ctx.gpa);
    defer arena.deinit();
    while (true) {
        const line = reader.interface.takeDelimiterInclusive('\n') catch |err| switch (err) {
            error.StreamTooLong => {
                // A line longer than the buffer: drop it.
                _ = reader.interface.discardDelimiterInclusive('\n') catch break;
                continue;
            },
            else => break,
        };
        const text = std.mem.trimEnd(u8, line, "\r\n");
        if (jobs.progressJson(text)) |json| {
            _ = arena.reset(.retain_capacity);
            s.ctx.table.setProgress(io, s.slot, json, jobs.parseProgress(arena.allocator(), json));
        } else if (text.len > 0) {
            s.addTail(text);
            if (s.ctx.verbose or notable(text)) log.say(io, "job {s}: {s}", .{ s.id, text });
        }
    }
}

/// Stops the job's whole process tree: render.js and every ffmpeg it started.
fn killTree(s: *Shared) void {
    const pid = s.pid orelse return;
    if (builtin.os.tag == .windows) {
        const process_id = GetProcessId(pid);
        var num: [16]u8 = undefined;
        const text = std.fmt.bufPrint(&num, "{d}", .{process_id}) catch return;
        _ = std.process.run(s.ctx.gpa, s.ctx.io, .{ .argv = &.{ "taskkill", "/pid", text, "/T", "/F" } }) catch {};
        return;
    }
    // render.js runs in its own process group (pgid = its pid), so the negative pid reaches ffmpeg too.
    std.posix.kill(-pid, .TERM) catch {};
    var waited: u32 = 0;
    while (!s.done.load(.acquire) and waited < 30) : (waited += 1) s.ctx.io.sleep(.fromMilliseconds(100), .awake) catch return;
    if (!s.done.load(.acquire)) std.posix.kill(-pid, .KILL) catch {};
}

extern "kernel32" fn GetProcessId(process: std.os.windows.HANDLE) callconv(.winapi) u32;

/// Every few seconds: the latest progress to the server, which answers whether it still wants the job.
fn tick(s: *Shared) void {
    const ctx = s.ctx;
    var api = Api.init(ctx.gpa, ctx.io, ctx.server, ctx.token);
    defer api.deinit();
    var last_seq: u64 = 0;
    var last_shown: [64]u8 = undefined;
    var last_shown_len: usize = 0;
    var path_buf: [128]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "/local-worker/jobs/{s}/progress", .{s.id}) catch return;
    while (!s.done.load(.acquire)) {
        var slept: u32 = 0;
        while (slept < progress_every_ms and !s.done.load(.acquire)) : (slept += 100) ctx.io.sleep(.fromMilliseconds(100), .awake) catch return;
        if (s.done.load(.acquire)) return;
        const e = ctx.table.snapshot(ctx.io, s.slot);
        var body_buf: [1100]u8 = undefined;
        const body = if (e.seq != last_seq and e.raw_len > 0)
            std.fmt.bufPrint(&body_buf, "{{\"progress\":{s}}}", .{e.raw[0..e.raw_len]}) catch "{\"progress\":null}"
        else
            "{\"progress\":null}";
        last_seq = e.seq;
        if (e.progress) |p| {
            var shown_buf: [64]u8 = undefined;
            const shown = std.fmt.bufPrint(&shown_buf, "{s} {d:.0}%", .{ if (e.phase_len > 0) e.phase[0..e.phase_len] else e.task[0..e.task_len], p }) catch "";
            if (!std.mem.eql(u8, shown, last_shown[0..last_shown_len])) {
                log.say(ctx.io, "job {s}: {s}", .{ s.id, shown });
                @memcpy(last_shown[0..shown.len], shown);
                last_shown_len = shown.len;
            }
        }
        const r = api.postRaw(path, body) catch |err| {
            log.say(ctx.io, "job {s}: progress not sent ({s})", .{ s.id, @errorName(err) });
            continue;
        };
        defer r.deinit(ctx.gpa);
        if (std.mem.indexOf(u8, r.body, "\"cancelled\":true") != null and !s.cancelled.load(.acquire)) {
            s.cancelled.store(true, .release);
            log.say(ctx.io, "job {s}: stopped by the server", .{s.id});
            killTree(s);
        }
    }
}

/// Runs a job to the end and reports it. Owns `id` and `input_json` (freed here); never fails.
pub fn run(ctx: *Ctx, id: []u8, input_json: []u8) void {
    defer {
        ctx.gpa.free(id);
        ctx.gpa.free(input_json);
        _ = ctx.active.fetchSub(1, .acq_rel);
    }
    runInner(ctx, id, input_json) catch |err| {
        log.say(ctx.io, "job {s}: could not run ({s})", .{ id, @errorName(err) });
        report(ctx, id, .{ .@"error" = @errorName(err) });
    };
}

const Outcome = union(enum) { output: []const u8, @"error": []const u8 };

fn report(ctx: *Ctx, id: []const u8, outcome: Outcome) void {
    var api = Api.init(ctx.gpa, ctx.io, ctx.server, ctx.token);
    defer api.deinit();
    var path_buf: [128]u8 = undefined;
    const path = std.fmt.bufPrint(&path_buf, "/local-worker/jobs/{s}/done", .{id}) catch return;
    const r = switch (outcome) {
        .output => |raw| blk: {
            const body = std.fmt.allocPrint(ctx.gpa, "{{\"output\":{s}}}", .{raw}) catch return;
            defer ctx.gpa.free(body);
            break :blk api.postRaw(path, body);
        },
        .@"error" => |msg| api.post(path, .{ .@"error" = msg }),
    } catch |err| {
        log.say(ctx.io, "job {s}: result not sent ({s})", .{ id, @errorName(err) });
        return;
    };
    r.deinit(ctx.gpa);
}

fn runInner(ctx: *Ctx, id: []const u8, input_json: []const u8) !void {
    const io = ctx.io;
    var arena: std.heap.ArenaAllocator = .init(ctx.gpa);
    defer arena.deinit();
    const input = try prepareInput(arena.allocator(), input_json, ctx.gpu_stitch);
    const slot = ctx.table.add(io, id, input.task) orelse return error.NoFreeSlot;
    defer ctx.table.remove(io, slot);
    const started = Io.Clock.awake.now(io);
    log.say(io, "job {s}: {s} started", .{ id, input.task });

    var child = try std.process.spawn(io, .{
        .argv = &.{ ctx.node, ctx.render_js },
        .environ_map = ctx.env,
        .stdin = .pipe,
        .stdout = .pipe,
        .stderr = .pipe,
        .pgid = if (builtin.os.tag == .windows) null else 0,
        .create_no_window = true,
    });
    var shared: Shared = .{ .ctx = ctx, .slot = slot, .id = id, .pid = child.id };

    {
        var wbuf: [8192]u8 = undefined;
        var w = child.stdin.?.writer(io, &wbuf);
        w.interface.writeAll(input.json) catch {};
        w.interface.flush() catch {};
        child.stdin.?.close(io);
        child.stdin = null;
    }
    const err_thread = try std.Thread.spawn(.{}, readStderr, .{ &shared, child.stderr.? });
    const tick_thread = try std.Thread.spawn(.{}, tick, .{&shared});

    var obuf: [16 * 1024]u8 = undefined;
    var out_reader = child.stdout.?.reader(io, &obuf);
    const out = out_reader.interface.allocRemaining(arena.allocator(), .limited(64 * 1024 * 1024)) catch "";
    err_thread.join();
    const term = child.wait(io) catch |err| blk: {
        log.say(io, "job {s}: wait failed ({s})", .{ id, @errorName(err) });
        break :blk std.process.Child.Term{ .unknown = 0 };
    };
    shared.done.store(true, .release);
    tick_thread.join();

    const secs = @divTrunc(started.durationTo(Io.Clock.awake.now(io)).nanoseconds, std.time.ns_per_s);
    if (shared.cancelled.load(.acquire)) return;
    if (lastJsonLine(out)) |raw| {
        if (std.mem.indexOf(u8, raw, "\"error\"") != null) {
            log.say(io, "job {s}: {s} failed after {d}s: {s}", .{ id, input.task, secs, raw });
        } else {
            log.say(io, "job {s}: {s} done in {d}s", .{ id, input.task, secs });
        }
        report(ctx, id, .{ .output = raw });
        return;
    }
    var tail_buf: [600]u8 = undefined;
    const code: i64 = switch (term) {
        .exited => |c| c,
        else => -1,
    };
    const msg = try std.fmt.allocPrint(arena.allocator(), "render.js exited {d}: {s}", .{ code, shared.lastLines(&tail_buf) });
    log.say(io, "job {s}: {s} failed after {d}s: {s}", .{ id, input.task, secs, msg });
    report(ctx, id, .{ .@"error" = msg });
}

test "the GPU stitch becomes CPU without gpu-stitch; the task is read" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const a = try prepareInput(arena.allocator(), "{\"task\":\"stitch\",\"stitch_engine\":\"gpu\"}", false);
    try std.testing.expectEqualStrings("stitch", a.task);
    try std.testing.expect(std.mem.indexOf(u8, a.json, "\"stitch_engine\":\"cpu\"") != null);
    const b = try prepareInput(arena.allocator(), "{\"stitch_engine\":\"gpu\"}", true);
    try std.testing.expectEqualStrings("render", b.task);
    try std.testing.expect(std.mem.indexOf(u8, b.json, "\"gpu\"") != null);
}

test "the result is render.js's last stdout line, when it is JSON" {
    try std.testing.expectEqualStrings("{\"chunks\":3}", lastJsonLine("noise\n{\"chunks\":3}\n").?);
    try std.testing.expect(lastJsonLine("no json here\n") == null);
    try std.testing.expect(notable("source download stalled; restarting"));
    try std.testing.expect(!notable("frame=  120 fps=30"));
}
