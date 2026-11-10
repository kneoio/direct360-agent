//! The agent's pairing and status, shared by the job loop (which runs with the current pairing and reports how it
//! goes), the browser connect (which replaces the pairing) and the tray (which shows the status). A new pairing bumps
//! `generation`, which makes the job loop start again with it.
const std = @import("std");
const Io = std.Io;

pub const Status = enum {
    /// No pairing yet, or the server forgot it: connect from the tray.
    unpaired,
    starting,
    /// Paired and taking jobs.
    ready,
    /// The server is not reached; the loop keeps trying.
    unreachable_server,
    /// The server refused this version: update.
    outdated,
    /// Cannot run jobs (a tool is missing, or the loop failed); `message` says why.
    stopped,
};

pub const Creds = struct {
    server: []const u8,
    token: []const u8,
    web: []const u8,
    generation: u64,
};

pub const Snapshot = struct {
    status: Status,
    message: [200]u8,
    message_len: usize,

    pub fn messageSlice(s: *const Snapshot) []const u8 {
        return s.message[0..s.message_len];
    }
};

pub const Session = struct {
    gpa: std.mem.Allocator,
    mutex: Io.Mutex = .init,
    server: []u8 = &.{},
    token: []u8 = &.{},
    web: []u8 = &.{},
    generation: std.atomic.Value(u64) = .init(0),
    status: Status = .starting,
    message: [200]u8 = undefined,
    message_len: usize = 0,

    pub fn init(gpa: std.mem.Allocator, io: Io, server: []const u8, token: []const u8, web: []const u8) !Session {
        var s: Session = .{ .gpa = gpa };
        try s.setCreds(io, server, token, web);
        s.generation.store(0, .release);
        return s;
    }

    pub fn deinit(s: *Session) void {
        s.gpa.free(s.server);
        s.gpa.free(s.token);
        s.gpa.free(s.web);
    }

    /// Replaces the pairing; the job loop notices and starts again with it.
    pub fn setCreds(s: *Session, io: Io, server: []const u8, token: []const u8, web: []const u8) !void {
        const new_server = try s.gpa.dupe(u8, server);
        errdefer s.gpa.free(new_server);
        const new_token = try s.gpa.dupe(u8, token);
        errdefer s.gpa.free(new_token);
        const new_web = try s.gpa.dupe(u8, web);
        s.mutex.lockUncancelable(io);
        defer s.mutex.unlock(io);
        s.gpa.free(s.server);
        s.gpa.free(s.token);
        s.gpa.free(s.web);
        s.server = new_server;
        s.token = new_token;
        s.web = new_web;
        _ = s.generation.fetchAdd(1, .acq_rel);
    }

    /// Copies of the current pairing, in `arena`.
    pub fn creds(s: *Session, io: Io, arena: std.mem.Allocator) !Creds {
        s.mutex.lockUncancelable(io);
        defer s.mutex.unlock(io);
        return .{
            .server = try arena.dupe(u8, s.server),
            .token = try arena.dupe(u8, s.token),
            .web = try arena.dupe(u8, s.web),
            .generation = s.generation.load(.acquire),
        };
    }

    pub fn changed(s: *Session, generation: u64) bool {
        return s.generation.load(.acquire) != generation;
    }

    pub fn setStatus(s: *Session, io: Io, status: Status, message: []const u8) void {
        s.mutex.lockUncancelable(io);
        defer s.mutex.unlock(io);
        s.status = status;
        s.message_len = @min(s.message.len, message.len);
        @memcpy(s.message[0..s.message_len], message[0..s.message_len]);
    }

    pub fn snapshot(s: *Session, io: Io) Snapshot {
        s.mutex.lockUncancelable(io);
        defer s.mutex.unlock(io);
        return .{ .status = s.status, .message = s.message, .message_len = s.message_len };
    }

    /// The site to open (the page that connected this agent says it; else the server without /api), into `buf`.
    pub fn webBase(s: *Session, io: Io, buf: []u8) []const u8 {
        s.mutex.lockUncancelable(io);
        defer s.mutex.unlock(io);
        const base = if (s.web.len > 0) s.web else trimApi(s.server);
        const n = @min(buf.len, base.len);
        @memcpy(buf[0..n], base[0..n]);
        return buf[0..n];
    }
};

pub fn trimApi(server: []const u8) []const u8 {
    const s = std.mem.trimEnd(u8, server, "/");
    return if (std.mem.endsWith(u8, s, "/api")) s[0 .. s.len - 4] else s;
}

test "the site is the server without /api unless the connecting page said otherwise" {
    try std.testing.expectEqualStrings("https://direct360.app", trimApi("https://direct360.app/api"));
    try std.testing.expectEqualStrings("http://x:5173", trimApi("http://x:5173/"));
    const io = std.testing.io;
    var s = try Session.init(std.testing.allocator, io, "https://direct360.app/api", "", "");
    defer s.deinit();
    var buf: [100]u8 = undefined;
    try std.testing.expectEqualStrings("https://direct360.app", s.webBase(io, &buf));
    const before = s.generation.load(.acquire);
    try s.setCreds(io, "http://127.0.0.1:4321", "tok", "http://127.0.0.1:5173");
    try std.testing.expect(s.changed(before));
    try std.testing.expectEqualStrings("http://127.0.0.1:5173", s.webBase(io, &buf));
}
