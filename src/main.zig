//! Direct360 agent: runs a Direct360 user's heavy video jobs (stitch, camera grid, preview copy, telemetry,
//! renders) on their own computer instead of the cloud. It takes the same jobs a cloud worker takes from the
//! Direct360 server and runs them with the worker pipeline (worker/render.js) and the computer's own ffmpeg.
//!
//!   direct360-agent pair ABCD-EFGH     once, with the code from Profile → Processing
//!   direct360-agent                    then keep it running
//!   direct360-agent info               what this computer reports
//!
//! Options: --server <url>, --ffmpeg <folder with ffmpeg and ffprobe>, --worker <path to render.js>,
//! --node <path to node>, --verbose.
const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const Api = @import("api.zig").Api;
const agent = @import("agent.zig");
const config = @import("config.zig");
const job = @import("job.zig");
const jobs = @import("jobs.zig");
const log = @import("log.zig");
const machine = @import("machine.zig");

const usage =
    \\Usage: direct360-agent [pair <code> | info] [--server <url>] [--ffmpeg <folder>] [--worker <render.js>] [--node <node>] [--verbose]
    \\
;

const Options = struct {
    command: enum { run, pair, info, version } = .run,
    code: ?[]const u8 = null,
    server: ?[]const u8 = null,
    ffmpeg_dir: ?[]const u8 = null,
    worker: ?[]const u8 = null,
    node: []const u8 = "node",
    verbose: bool = false,
};

pub fn parseArgs(args: []const []const u8) !Options {
    var o: Options = .{};
    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const a = args[i];
        const value = struct {
            fn next(list: []const []const u8, at: *usize) ![]const u8 {
                at.* += 1;
                if (at.* >= list.len) return error.MissingValue;
                return list[at.*];
            }
        };
        if (std.mem.eql(u8, a, "--server")) {
            o.server = std.mem.trimEnd(u8, try value.next(args, &i), "/");
        } else if (std.mem.eql(u8, a, "--ffmpeg")) {
            o.ffmpeg_dir = try value.next(args, &i);
        } else if (std.mem.eql(u8, a, "--worker")) {
            o.worker = try value.next(args, &i);
        } else if (std.mem.eql(u8, a, "--node")) {
            o.node = try value.next(args, &i);
        } else if (std.mem.eql(u8, a, "--verbose")) {
            o.verbose = true;
        } else if (std.mem.eql(u8, a, "--version") or std.mem.eql(u8, a, "-v")) {
            o.command = .version;
        } else if (std.mem.eql(u8, a, "pair")) {
            o.command = .pair;
            o.code = try value.next(args, &i);
        } else if (std.mem.eql(u8, a, "info")) {
            o.command = .info;
        } else {
            return error.UnknownArgument;
        }
    }
    return o;
}

fn exists(io: Io, path: []const u8) bool {
    Io.Dir.cwd().access(io, path, .{}) catch return false;
    return true;
}

/// render.js: --worker, else worker/render.js next to the agent, one folder up, or in the current folder.
fn findRenderJs(arena: std.mem.Allocator, io: Io, given: ?[]const u8) !?[]const u8 {
    if (given) |p| return if (exists(io, p)) p else null;
    const exe_dir = std.process.executableDirPathAlloc(io, arena) catch "";
    const candidates = [_][]const u8{
        try std.fs.path.join(arena, &.{ exe_dir, "worker", "render.js" }),
        try std.fs.path.join(arena, &.{ exe_dir, "..", "worker", "render.js" }),
        "worker/render.js",
    };
    for (candidates) |c| if (exists(io, c)) return c;
    return null;
}

fn fail(comptime fmt: []const u8, args: anytype) noreturn {
    std.debug.print(fmt ++ "\n", args);
    std.process.exit(1);
}

pub fn main(init: std.process.Init) !void {
    const gpa = init.gpa;
    const io = init.io;
    const arena = init.arena.allocator();
    const env = init.environ_map;
    const args = try init.minimal.args.toSlice(arena);
    const opts = parseArgs(args) catch fail("{s}", .{usage});

    if (opts.command == .version) {
        std.debug.print("direct360-agent {s}\n", .{machine.version});
        return;
    }

    // ffmpeg: --ffmpeg folder, else the one on PATH. render.js reads D360_FFMPEG / D360_FFPROBE.
    const exe_suffix = if (builtin.os.tag == .windows) ".exe" else "";
    const ffmpeg = if (opts.ffmpeg_dir) |d| try std.fs.path.join(arena, &.{ d, "ffmpeg" ++ exe_suffix }) else "ffmpeg";
    const ffprobe = if (opts.ffmpeg_dir) |d| try std.fs.path.join(arena, &.{ d, "ffprobe" ++ exe_suffix }) else "ffprobe";
    if (machine.output(arena, io, &.{ ffmpeg, "-hide_banner", "-version" }) == null)
        fail("ffmpeg was not found ({s}). Install ffmpeg, or pass --ffmpeg <folder that has ffmpeg and ffprobe>.", .{ffmpeg});
    if (machine.output(arena, io, &.{ ffprobe, "-hide_banner", "-version" }) == null)
        fail("ffprobe was not found ({s}). It comes with ffmpeg; pass --ffmpeg <folder> if it is elsewhere.", .{ffprobe});
    try env.put("D360_FFMPEG", ffmpeg);
    try env.put("D360_FFPROBE", ffprobe);

    const render_js = (try findRenderJs(arena, io, opts.worker)) orelse
        fail("worker/render.js was not found. Pass --worker <path to render.js> (it is in kneoio/direct360-helper).", .{});
    if (machine.output(arena, io, &.{ opts.node, "--version" }) == null)
        fail("Node.js was not found ({s}); the worker pipeline still runs on Node. Install Node 20+ or pass --node <path>.", .{opts.node});

    // GoPro telemetry: GPMF2JSON, else worker/gpmf/gpmf2json beside render.js.
    var gpmf: ?[]const u8 = env.get("GPMF2JSON");
    if (gpmf == null) {
        const beside = try std.fs.path.join(arena, &.{ std.fs.path.dirname(render_js) orelse ".", "gpmf", "gpmf2json" ++ exe_suffix });
        if (exists(io, beside)) {
            gpmf = beside;
            try env.put("GPMF2JSON", beside);
        }
    }
    const gpu_stitch = env.get("D360_GPU_STITCH") orelse "gpu-stitch";
    const info = try machine.collect(arena, io, .{ .ffmpeg = ffmpeg, .ffprobe = ffprobe, .gpmf = gpmf }, gpu_stitch);

    if (opts.command == .info) {
        const text = try std.json.Stringify.valueAlloc(arena, info, .{ .whitespace = .indent_2 });
        std.debug.print("{s}\n", .{text});
        return;
    }

    const cfg_path = (try config.path(arena, env)) orelse fail("No home folder (HOME / USERPROFILE) to keep the pairing in.", .{});
    var cfg = try config.load(arena, io, cfg_path);
    if (opts.server) |s| cfg.server = s;

    if (opts.command == .pair) {
        var api = Api.init(gpa, io, cfg.server, "");
        defer api.deinit();
        const r = api.post("/local-worker/pair", .{ .code = opts.code.?, .info = info }) catch |err| switch (err) {
            error.ServerRefused => fail("Pairing failed: the code is not valid or has expired; get a new one in your profile.", .{}),
            error.Outdated => fail("This agent is too old for the server; update it.", .{}),
            else => fail("Pairing failed: {s}", .{@errorName(err)}),
        };
        defer r.deinit(gpa);
        const Paired = struct { token: []const u8 };
        const paired = try std.json.parseFromSliceLeaky(Paired, arena, r.body, .{ .ignore_unknown_fields = true });
        try config.save(gpa, io, cfg_path, .{ .server = cfg.server, .token = paired.token });
        log.say(io, "Paired with {s}. Now start the agent: direct360-agent", .{cfg.server});
        return;
    }

    if (cfg.token.len == 0) fail("This agent is not paired yet. In Direct360, open Profile → Processing for a code, then run:\n  direct360-agent pair <code>", .{});
    log.say(io, "ffmpeg {s}, {d} threads, {d:.0} GB, hardware encoders: {s}", .{
        if (info.ffmpeg.len > 0) info.ffmpeg else "?",
        info.cpuThreads,
        info.memoryGb,
        if (info.encoders.len > 0) try std.mem.join(arena, ", ", info.encoders) else "none",
    });
    if (!info.overlay) log.say(io, "warning: this ffmpeg has no libass (`ass` filter); renders with the info overlay will fail", .{});
    if (!info.gpmf) log.say(io, "warning: gpmf2json is missing; GoPro telemetry will fail (build it in worker/gpmf)", .{});

    var table: jobs.Table = .{};
    var active = std.atomic.Value(u32).init(0);
    var ctx: job.Ctx = .{
        .gpa = gpa,
        .io = io,
        .server = cfg.server,
        .token = cfg.token,
        .env = env,
        .node = opts.node,
        .render_js = render_js,
        .gpu_stitch = info.gpuStitch,
        .verbose = opts.verbose,
        .table = &table,
        .active = &active,
    };
    agent.serve(&ctx, &info) catch |err| switch (err) {
        error.NotPaired => fail("This agent is no longer paired. Pair it again from Profile → Processing.", .{}),
        error.Outdated => fail("This agent is too old for the server; update it.", .{}),
        else => fail("The agent stopped: {s}", .{@errorName(err)}),
    };
}

test "command line: pair with a code, options with values" {
    const o = try parseArgs(&.{ "agent", "pair", "ABCD-EFGH", "--server", "http://x/api/", "--verbose" });
    try std.testing.expectEqual(.pair, o.command);
    try std.testing.expectEqualStrings("ABCD-EFGH", o.code.?);
    try std.testing.expectEqualStrings("http://x/api", o.server.?);
    try std.testing.expect(o.verbose);
    try std.testing.expectError(error.MissingValue, parseArgs(&.{ "agent", "pair" }));
    try std.testing.expectError(error.UnknownArgument, parseArgs(&.{ "agent", "fly" }));
}

test {
    _ = @import("api.zig");
    _ = @import("config.zig");
    _ = @import("cpu.zig");
    _ = @import("jobs.zig");
    _ = @import("job.zig");
    _ = @import("machine.zig");
}
