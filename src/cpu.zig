//! How busy the computer's cores are: the busy share of all cores between two samples, from the system's own
//! counters (Linux /proc/stat, Windows GetSystemTimes, macOS host_statistics). Null where a system gives none.
const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;

pub const Times = struct { busy: u64, total: u64 };

pub const Sampler = struct {
    last: ?Times = null,

    /// Busy percentage (0-100) since the previous call; null on the first call or without counters.
    pub fn sample(s: *Sampler, io: Io) ?f64 {
        const now = read(io) orelse return null;
        defer s.last = now;
        const before = s.last orelse return null;
        return percent(before, now);
    }
};

pub fn percent(before: Times, now: Times) ?f64 {
    if (now.total <= before.total) return null;
    const busy: f64 = @floatFromInt(now.busy -| before.busy);
    const total: f64 = @floatFromInt(now.total - before.total);
    return @min(100.0, busy / total * 100.0);
}

fn read(io: Io) ?Times {
    return switch (builtin.os.tag) {
        .linux => readLinux(io),
        .windows => readWindows(),
        .macos => readMac(),
        else => null,
    };
}

/// The first line of /proc/stat: `cpu user nice system idle iowait irq softirq steal ...`.
pub fn parseProcStat(text: []const u8) ?Times {
    const line_end = std.mem.indexOfScalar(u8, text, '\n') orelse text.len;
    var it = std.mem.tokenizeScalar(u8, text[0..line_end], ' ');
    const label = it.next() orelse return null;
    if (!std.mem.eql(u8, label, "cpu")) return null;
    var fields: [8]u64 = @splat(0);
    var n: usize = 0;
    while (it.next()) |tok| : (n += 1) {
        if (n >= fields.len) break;
        fields[n] = std.fmt.parseInt(u64, tok, 10) catch return null;
    }
    if (n < 4) return null;
    var total: u64 = 0;
    for (fields) |f| total += f;
    const idle = fields[3] + fields[4];
    return .{ .busy = total - idle, .total = total };
}

fn readLinux(io: Io) ?Times {
    var buf: [4096]u8 = undefined;
    const text = Io.Dir.cwd().readFile(io, "/proc/stat", &buf) catch return null;
    return parseProcStat(text);
}

const FILETIME = extern struct { low: u32, high: u32 };
extern "kernel32" fn GetSystemTimes(idle: *FILETIME, kernel: *FILETIME, user: *FILETIME) callconv(.winapi) i32;

fn readWindows() ?Times {
    if (builtin.os.tag != .windows) return null;
    var idle: FILETIME = undefined;
    var kernel: FILETIME = undefined;
    var user: FILETIME = undefined;
    if (GetSystemTimes(&idle, &kernel, &user) == 0) return null;
    const v = struct {
        fn of(t: FILETIME) u64 {
            return (@as(u64, t.high) << 32) | t.low;
        }
    };
    // Kernel time includes idle time.
    const total = v.of(kernel) + v.of(user);
    return .{ .busy = total -| v.of(idle), .total = total };
}

const host_cpu_load_info = extern struct { ticks: [4]u32 }; // user, system, idle, nice
extern "c" fn mach_host_self() u32;
extern "c" fn host_statistics(host: u32, flavor: i32, info: *host_cpu_load_info, count: *u32) i32;

fn readMac() ?Times {
    if (builtin.os.tag != .macos) return null;
    var info: host_cpu_load_info = undefined;
    var count: u32 = @sizeOf(host_cpu_load_info) / @sizeOf(u32);
    const HOST_CPU_LOAD_INFO = 3;
    if (host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, &info, &count) != 0) return null;
    const user: u64 = info.ticks[0];
    const system: u64 = info.ticks[1];
    const idle: u64 = info.ticks[2];
    const nice: u64 = info.ticks[3];
    return .{ .busy = user + system + nice, .total = user + system + idle + nice };
}

test "/proc/stat: busy share between two samples" {
    const a = parseProcStat("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3 4\n").?;
    const b = parseProcStat("cpu  200 0 200 900 0 0 0 0 0 0\n").?;
    try std.testing.expectEqual(@as(u64, 200), a.busy);
    try std.testing.expectApproxEqAbs(@as(f64, 200.0 / 300.0 * 100.0), percent(a, b).?, 1e-9);
    try std.testing.expect(parseProcStat("intr 1 2 3") == null);
}
