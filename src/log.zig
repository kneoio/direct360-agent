//! One line per event, prefixed with the time (UTC, HH:MM:SS): on stderr, and while testing also in a log file
//! (`~/.direct360-agent.log`, appended across runs, started afresh once it passes `max_file_bytes`).
const std = @import("std");
const Io = std.Io;

pub const file_name = ".direct360-agent.log";
const max_file_bytes = 5 * 1024 * 1024;

var file: ?Io.File = null;
var file_io: Io = undefined;
var mutex: Io.Mutex = .init;

/// Opens the log file; lines go to stderr only when it cannot be opened.
pub fn openFile(io: Io, path: []const u8) void {
    const f = Io.Dir.cwd().createFile(io, path, .{ .truncate = false }) catch return;
    const len = f.length(io) catch 0;
    if (len > max_file_bytes) f.setLength(io, 0) catch {};
    file = f;
    file_io = io;
}

pub fn say(io: Io, comptime fmt: []const u8, args: anytype) void {
    const now = Io.Clock.real.now(io);
    const secs: u64 = @intCast(@max(0, @divTrunc(now.nanoseconds, std.time.ns_per_s)));
    const day = secs % 86400;
    var buf: [2048]u8 = undefined;
    const line = std.fmt.bufPrint(&buf, "{d:0>2}:{d:0>2}:{d:0>2} " ++ fmt ++ "\n", .{ day / 3600, (day / 60) % 60, day % 60 } ++ args) catch blk: {
        buf[buf.len - 4] = '.';
        buf[buf.len - 3] = '.';
        buf[buf.len - 2] = '.';
        buf[buf.len - 1] = '\n';
        break :blk buf[0..];
    };
    mutex.lockUncancelable(io);
    defer mutex.unlock(io);
    std.debug.print("{s}", .{line});
    const f = file orelse return;
    const end = f.length(file_io) catch return;
    f.writePositionalAll(file_io, line, end) catch {};
}
