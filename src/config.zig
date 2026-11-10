//! The pairing kept between runs: which server, and the agent's token for it.
//! Stored as JSON in the user's home folder (`~/.direct360-agent.json`).
const std = @import("std");
const Io = std.Io;

pub const default_server = "https://direct360.app/api";
const file_name = ".direct360-agent.json";

pub const Config = struct {
    server: []const u8 = default_server,
    token: []const u8 = "",
    /// The site that connected this agent (its Profile page is opened from the tray); empty: the server without /api.
    web: []const u8 = "",
};

/// `~/.direct360-agent.json` (USERPROFILE on Windows), or null when no home folder is known.
pub fn path(gpa: std.mem.Allocator, env: *const std.process.Environ.Map) !?[]u8 {
    const home = env.get("HOME") orelse env.get("USERPROFILE") orelse return null;
    return try std.fs.path.join(gpa, &.{ home, file_name });
}

/// The stored pairing, or the defaults when there is none yet. Strings live in `arena`.
pub fn load(arena: std.mem.Allocator, io: Io, file: []const u8) !Config {
    const text = Io.Dir.cwd().readFileAlloc(io, file, arena, .limited(64 * 1024)) catch |err| switch (err) {
        error.FileNotFound => return .{},
        else => return err,
    };
    return parse(arena, text);
}

pub fn parse(arena: std.mem.Allocator, text: []const u8) !Config {
    const parsed = try std.json.parseFromSliceLeaky(Config, arena, text, .{ .ignore_unknown_fields = true, .allocate = .alloc_always });
    return parsed;
}

pub fn save(gpa: std.mem.Allocator, io: Io, file: []const u8, config: Config) !void {
    const text = try std.json.Stringify.valueAlloc(gpa, config, .{ .whitespace = .indent_2 });
    defer gpa.free(text);
    try Io.Dir.cwd().writeFile(io, .{ .sub_path = file, .data = text });
}

test "a stored pairing reads back; unknown keys are ignored" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const c = try parse(arena.allocator(), "{\"server\":\"http://x/api\",\"token\":\"abc\",\"other\":1}");
    try std.testing.expectEqualStrings("http://x/api", c.server);
    try std.testing.expectEqualStrings("abc", c.token);
    const empty = try parse(arena.allocator(), "{}");
    try std.testing.expectEqualStrings(default_server, empty.server);
    try std.testing.expectEqualStrings("", empty.token);
}
