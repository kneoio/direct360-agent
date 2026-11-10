//! Calls to the Direct360 server's local-worker API (direct360-server: src/localWorkers.js and the
//! `/local-worker/*` routes). One `Api` per thread: each has its own HTTP client.
const std = @import("std");
const Io = std.Io;

pub const Response = struct {
    status: u16,
    body: []u8,

    pub fn deinit(r: Response, gpa: std.mem.Allocator) void {
        gpa.free(r.body);
    }
};

pub const Api = struct {
    gpa: std.mem.Allocator,
    io: Io,
    server: []const u8,
    token: []const u8,
    client: std.http.Client,

    pub fn init(gpa: std.mem.Allocator, io: Io, server: []const u8, token: []const u8) Api {
        return .{ .gpa = gpa, .io = io, .server = server, .token = token, .client = .{ .allocator = gpa, .io = io } };
    }

    pub fn deinit(api: *Api) void {
        api.client.deinit();
    }

    /// GET or POST `path` on the server; `json` is the request body (POST) or null (GET). The caller frees the body.
    pub fn call(api: *Api, path: []const u8, json: ?[]const u8) !Response {
        const url = try std.fmt.allocPrint(api.gpa, "{s}{s}", .{ api.server, path });
        defer api.gpa.free(url);
        var auth_buf: [160]u8 = undefined;
        const auth = try std.fmt.bufPrint(&auth_buf, "Bearer {s}", .{api.token});
        var body: Io.Writer.Allocating = .init(api.gpa);
        errdefer body.deinit();
        const res = try api.client.fetch(.{
            .location = .{ .url = url },
            .method = if (json == null) .GET else .POST,
            .payload = json,
            .headers = .{
                .content_type = .{ .override = "application/json" },
                .authorization = if (api.token.len > 0) .{ .override = auth } else .omit,
            },
            .response_writer = &body.writer,
            // A fresh connection per call: on a kept-alive one, std.http.Client waits forever after a 204 (no job).
            .keep_alive = false,
        });
        return .{ .status = @intFromEnum(res.status), .body = try body.toOwnedSlice() };
    }

    /// POST a value as JSON; fails with `error.NotPaired` on 401 and `error.ServerRefused` on any other non-2xx.
    pub fn post(api: *Api, path: []const u8, value: anytype) !Response {
        const json = try std.json.Stringify.valueAlloc(api.gpa, value, .{ .emit_null_optional_fields = true });
        defer api.gpa.free(json);
        return api.postRaw(path, json);
    }

    pub fn postRaw(api: *Api, path: []const u8, json: []const u8) !Response {
        const r = try api.call(path, json);
        return checked(api.gpa, r);
    }

    pub fn get(api: *Api, path: []const u8) !Response {
        return checked(api.gpa, try api.call(path, null));
    }
};

fn checked(gpa: std.mem.Allocator, r: Response) !Response {
    if (r.status >= 200 and r.status < 300) return r;
    defer r.deinit(gpa);
    if (r.status == 401) return error.NotPaired;
    if (r.status == 426) {
        std.log.err("{s}", .{serverError(r.body)});
        return error.Outdated;
    }
    std.log.err("server answered {d}: {s}", .{ r.status, serverError(r.body) });
    return error.ServerRefused;
}

/// The `error` text of a JSON error body, or the body itself.
pub fn serverError(body: []const u8) []const u8 {
    const key = "\"error\":\"";
    const at = std.mem.indexOf(u8, body, key) orelse return body;
    const rest = body[at + key.len ..];
    const end = std.mem.indexOfScalar(u8, rest, '"') orelse rest.len;
    return rest[0..end];
}

test "a server error body gives its message" {
    try std.testing.expectEqualStrings("this code is not valid", serverError("{\"error\":\"this code is not valid\"}"));
    try std.testing.expectEqualStrings("plain", serverError("plain"));
}
