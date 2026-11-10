//! What this computer has, as the server's local worker record and the Direct360 profile show it: system,
//! processor, memory, ffmpeg version and hardware encoders, and which optional tools are present. The keys
//! match what direct360-server keeps (src/localWorkers.js, cleanInfo).
const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;

/// The agent's own release.
pub const version = "0.1.1";
/// The helper protocol it speaks, sent as `info.version`: the server refuses helpers older than its
/// HELPER_MIN_VERSION (direct360-server src/localWorkers.js) and only reads plain numbers ("2.0.3").
pub const protocol_version = "2.0.4";

pub const Info = struct {
    version: []const u8 = protocol_version,
    host: []const u8,
    os: []const u8,
    arch: []const u8,
    cpu: []const u8,
    cpuThreads: u32,
    memoryGb: f64,
    ffmpeg: []const u8,
    encoders: []const []const u8,
    overlay: bool,
    gpmf: bool,
    gpuStitch: bool,
};

pub const Tools = struct {
    ffmpeg: []const u8,
    ffprobe: []const u8,
    gpmf: ?[]const u8,
};

/// Output of `argv`, or null when it cannot run or exits non-zero.
pub fn output(arena: std.mem.Allocator, io: Io, argv: []const []const u8) ?[]const u8 {
    const r = std.process.run(arena, io, .{ .argv = argv, .stdout_limit = .limited(4 * 1024 * 1024) }) catch return null;
    return switch (r.term) {
        .exited => |code| if (code == 0) r.stdout else null,
        else => null,
    };
}

pub fn firstLine(text: []const u8) []const u8 {
    const end = std.mem.indexOfScalar(u8, text, '\n') orelse text.len;
    return std.mem.trim(u8, text[0..end], " \r\t");
}

/// "ffmpeg version 8.0.1-3ubuntu2 Copyright ..." → "8.0.1-3ubuntu2".
pub fn ffmpegVersion(line: []const u8) []const u8 {
    const prefix = "ffmpeg version ";
    if (!std.mem.startsWith(u8, line, prefix)) return line;
    const rest = line[prefix.len..];
    const end = std.mem.indexOfScalar(u8, rest, ' ') orelse rest.len;
    return rest[0..end];
}

/// Hardware video encoders in `ffmpeg -encoders` output: h264/hevc/av1 on nvenc, qsv, videotoolbox, vaapi or amf.
pub fn hardwareEncoders(arena: std.mem.Allocator, text: []const u8) ![]const []const u8 {
    var list: std.ArrayList([]const u8) = .empty;
    var lines = std.mem.tokenizeScalar(u8, text, '\n');
    while (lines.next()) |line| {
        var words = std.mem.tokenizeScalar(u8, line, ' ');
        _ = words.next() orelse continue; // flags column
        const name = words.next() orelse continue;
        const codecs = [_][]const u8{ "h264_", "hevc_", "av1_" };
        const kinds = [_][]const u8{ "nvenc", "qsv", "videotoolbox", "vaapi", "amf" };
        for (codecs) |c| {
            if (!std.mem.startsWith(u8, name, c)) continue;
            for (kinds) |k| {
                if (std.mem.eql(u8, name[c.len..], k)) try list.append(arena, name);
            }
        }
    }
    return list.items;
}

/// `ffmpeg -filters` lists `ass` (libass), which the info overlay needs.
pub fn hasAssFilter(text: []const u8) bool {
    var lines = std.mem.tokenizeScalar(u8, text, '\n');
    while (lines.next()) |line| {
        var words = std.mem.tokenizeScalar(u8, line, ' ');
        _ = words.next() orelse continue;
        const name = words.next() orelse continue;
        if (std.mem.eql(u8, name, "ass")) return true;
    }
    return false;
}

/// System name and kernel release, as the Node helper sends them ("Linux 6.8.0"); just the system on Windows.
fn osName(arena: std.mem.Allocator) []const u8 {
    if (builtin.os.tag == .windows) return "Windows";
    const u = std.posix.uname();
    const sys = std.mem.sliceTo(&u.sysname, 0);
    const rel = std.mem.sliceTo(&u.release, 0);
    return std.fmt.allocPrint(arena, "{s} {s}", .{ sys, rel }) catch sys;
}

/// The computer's name, as the profile shows it to tell computers apart.
fn hostName(arena: std.mem.Allocator) []const u8 {
    if (builtin.os.tag == .windows) return "";
    var buf: [std.posix.HOST_NAME_MAX]u8 = undefined;
    const name = std.posix.gethostname(&buf) catch return "";
    return arena.dupe(u8, name) catch "";
}

fn cpuModel(arena: std.mem.Allocator, io: Io) []const u8 {
    if (builtin.os.tag != .linux) return "";
    const text = Io.Dir.cwd().readFileAlloc(io, "/proc/cpuinfo", arena, .limited(1024 * 1024)) catch return "";
    var lines = std.mem.tokenizeScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "model name")) continue;
        const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
        return std.mem.trim(u8, line[colon + 1 ..], " \t");
    }
    return "";
}

/// Total and available memory in bytes; available is null where the system does not tell.
pub fn memory(io: Io) struct { total: u64, available: ?u64 } {
    const total = std.process.totalSystemMemory() catch 0;
    if (builtin.os.tag == .linux) {
        var buf: [4096]u8 = undefined;
        if (Io.Dir.cwd().readFile(io, "/proc/meminfo", &buf)) |text| {
            if (parseMemAvailable(text)) |kb| return .{ .total = total, .available = kb * 1024 };
        } else |_| {}
    }
    return .{ .total = total, .available = null };
}

pub fn parseMemAvailable(text: []const u8) ?u64 {
    var lines = std.mem.tokenizeScalar(u8, text, '\n');
    while (lines.next()) |line| {
        if (!std.mem.startsWith(u8, line, "MemAvailable:")) continue;
        var words = std.mem.tokenizeScalar(u8, line["MemAvailable:".len..], ' ');
        return std.fmt.parseInt(u64, words.next() orelse return null, 10) catch null;
    }
    return null;
}

pub fn gb(bytes: u64) f64 {
    return @as(f64, @floatFromInt(bytes)) / (1024.0 * 1024.0 * 1024.0);
}

/// `windows_name` is COMPUTERNAME, the computer's name on Windows.
pub fn collect(arena: std.mem.Allocator, io: Io, tools: Tools, gpu_stitch: []const u8, windows_name: ?[]const u8) !Info {
    const ffmpeg_out = output(arena, io, &.{ tools.ffmpeg, "-hide_banner", "-version" }) orelse "";
    const encoders_out = output(arena, io, &.{ tools.ffmpeg, "-hide_banner", "-encoders" }) orelse "";
    const filters_out = output(arena, io, &.{ tools.ffmpeg, "-hide_banner", "-filters" }) orelse "";
    return .{
        .host = if (builtin.os.tag == .windows) windows_name orelse "" else hostName(arena),
        .os = osName(arena),
        .arch = @tagName(builtin.cpu.arch),
        .cpu = cpuModel(arena, io),
        .cpuThreads = @intCast(std.Thread.getCpuCount() catch 1),
        .memoryGb = gb(memory(io).total),
        .ffmpeg = ffmpegVersion(firstLine(ffmpeg_out)),
        .encoders = try hardwareEncoders(arena, encoders_out),
        .overlay = hasAssFilter(filters_out),
        .gpmf = tools.gpmf != null,
        .gpuStitch = output(arena, io, &.{ gpu_stitch, "--version" }) != null,
    };
}

test "ffmpeg version, hardware encoders and the ass filter are read from ffmpeg's own output" {
    try std.testing.expectEqualStrings("8.0.1-3ubuntu2", ffmpegVersion("ffmpeg version 8.0.1-3ubuntu2 Copyright (c) 2000-2025"));
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const enc = try hardwareEncoders(arena.allocator(),
        \\ V....D libx264              libx264 H.264
        \\ V....D h264_nvenc           NVIDIA NVENC H.264 encoder
        \\ V....D hevc_qsv             HEVC (Intel Quick Sync Video acceleration)
        \\ V....D h264_v4l2m2m         V4L2 mem2mem H.264 encoder wrapper
    );
    try std.testing.expectEqual(@as(usize, 2), enc.len);
    try std.testing.expectEqualStrings("h264_nvenc", enc[0]);
    try std.testing.expect(hasAssFilter(" ... ass               V->V       Render ASS subtitles onto input video using the libass library.\n"));
    try std.testing.expect(!hasAssFilter(" ... scale             V->V       Scale the input video size.\n"));
}

test "available memory from /proc/meminfo" {
    try std.testing.expectEqual(@as(?u64, 12345), parseMemAvailable("MemTotal: 999 kB\nMemAvailable:   12345 kB\n"));
}
