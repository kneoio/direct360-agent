//! The jobs running right now, shared between the job threads (which update their step and progress) and the
//! stats thread (which reports them). Fixed slots, one per job the agent runs at once.
const std = @import("std");
const Io = std.Io;

pub const slots = 2;

pub const Progress = struct {
    phase: ?[]const u8 = null,
    progress: ?f64 = null,
};

/// `PROGRESS {"phase":"render","progress":42}` as worker/render.js prints it on stderr → its JSON part, or null.
pub fn progressJson(line: []const u8) ?[]const u8 {
    const prefix = "PROGRESS ";
    if (!std.mem.startsWith(u8, line, prefix)) return null;
    const json = std.mem.trim(u8, line[prefix.len..], " \r\t");
    if (json.len == 0 or json[0] != '{') return null;
    return json;
}

pub const Entry = struct {
    used: bool = false,
    id: [64]u8 = undefined,
    id_len: usize = 0,
    task: [32]u8 = undefined,
    task_len: usize = 0,
    phase: [32]u8 = undefined,
    phase_len: usize = 0,
    progress: ?f64 = null,
    /// The latest progress JSON exactly as render.js printed it; forwarded to the server as is.
    raw: [1024]u8 = undefined,
    raw_len: usize = 0,
    /// Bumped on every new progress line, so an unchanged report is not sent again.
    seq: u64 = 0,

    pub fn idSlice(e: *const Entry) []const u8 {
        return e.id[0..e.id_len];
    }
};

fn copyInto(dst: []u8, src: []const u8) usize {
    const n = @min(dst.len, src.len);
    @memcpy(dst[0..n], src[0..n]);
    return n;
}

pub const Table = struct {
    mutex: Io.Mutex = .init,
    entries: [slots]Entry = @splat(.{}),

    pub fn add(t: *Table, io: Io, id: []const u8, task: []const u8) ?usize {
        t.mutex.lockUncancelable(io);
        defer t.mutex.unlock(io);
        for (&t.entries, 0..) |*e, i| {
            if (e.used) continue;
            e.* = .{ .used = true };
            e.id_len = copyInto(&e.id, id);
            e.task_len = copyInto(&e.task, task);
            return i;
        }
        return null;
    }

    pub fn remove(t: *Table, io: Io, slot: usize) void {
        t.mutex.lockUncancelable(io);
        defer t.mutex.unlock(io);
        t.entries[slot].used = false;
    }

    pub fn count(t: *Table, io: Io) usize {
        t.mutex.lockUncancelable(io);
        defer t.mutex.unlock(io);
        var n: usize = 0;
        for (t.entries) |e| n += @intFromBool(e.used);
        return n;
    }

    /// Stores a progress line's JSON (and its phase and percentage, for the stats report).
    pub fn setProgress(t: *Table, io: Io, slot: usize, json: []const u8, parsed: Progress) void {
        t.mutex.lockUncancelable(io);
        defer t.mutex.unlock(io);
        const e = &t.entries[slot];
        e.raw_len = copyInto(&e.raw, json);
        e.phase_len = copyInto(&e.phase, parsed.phase orelse "");
        e.progress = parsed.progress;
        e.seq += 1;
    }

    /// A copy of one slot, taken under the lock.
    pub fn snapshot(t: *Table, io: Io, slot: usize) Entry {
        t.mutex.lockUncancelable(io);
        defer t.mutex.unlock(io);
        return t.entries[slot];
    }
};

pub fn parseProgress(arena: std.mem.Allocator, json: []const u8) Progress {
    return std.json.parseFromSliceLeaky(Progress, arena, json, .{ .ignore_unknown_fields = true }) catch .{};
}

test "progress lines: only PROGRESS with a JSON object" {
    try std.testing.expectEqualStrings("{\"phase\":\"render\",\"progress\":42}", progressJson("PROGRESS {\"phase\":\"render\",\"progress\":42}\r").?);
    try std.testing.expect(progressJson("ffmpeg exited 1") == null);
    try std.testing.expect(progressJson("PROGRESS oops") == null);
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const p = parseProgress(arena.allocator(), "{\"phase\":\"matrix\",\"progress\":12.5,\"segment\":2}");
    try std.testing.expectEqualStrings("matrix", p.phase.?);
    try std.testing.expectEqual(@as(f64, 12.5), p.progress.?);
}

test "the table keeps a fixed number of running jobs" {
    const io = std.testing.io;
    var t: Table = .{};
    const a = t.add(io, "job-a", "render").?;
    _ = t.add(io, "job-b", "telemetry").?;
    try std.testing.expect(t.add(io, "job-c", "render") == null);
    t.setProgress(io, a, "{\"progress\":5}", .{ .progress = 5 });
    try std.testing.expectEqual(@as(u64, 1), t.snapshot(io, a).seq);
    t.remove(io, a);
    try std.testing.expectEqual(@as(usize, 1), t.count(io));
}
