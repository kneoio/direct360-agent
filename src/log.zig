//! One line per event on stderr, prefixed with the time (UTC, HH:MM:SS).
const std = @import("std");
const Io = std.Io;

pub fn say(io: Io, comptime fmt: []const u8, args: anytype) void {
    const now = Io.Clock.real.now(io);
    const secs: u64 = @intCast(@max(0, @divTrunc(now.nanoseconds, std.time.ns_per_s)));
    const day = secs % 86400;
    std.debug.print("{d:0>2}:{d:0>2}:{d:0>2} " ++ fmt ++ "\n", .{ day / 3600, (day / 60) % 60, day % 60 } ++ args);
}
