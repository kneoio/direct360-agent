//! Connecting this agent to the user's Direct360 account in the browser, as direct360-helper 2.0.4 does: a one-time
//! server on 127.0.0.1 and a random state; the browser opens Profile → Processing with both
//! (`?helper-port=<port>&helper-state=<state>`), the signed-in user confirms there, and the page sends the browser
//! back to `http://127.0.0.1:<port>/pair?state=…&code=…&server=…&web=…`. The agent pairs with the server that page
//! belongs to, keeps the pairing, sends the browser back to the profile, and the job loop starts with it.
const std = @import("std");
const Io = std.Io;
const Api = @import("api.zig").Api;
const config = @import("config.zig");
const log = @import("log.zig");
const machine = @import("machine.zig");
const platform = @import("platform.zig");
const Session = @import("session.zig").Session;

const wait_ms = 10 * 60 * 1000;

pub const Connector = struct {
    gpa: std.mem.Allocator,
    io: Io,
    session: *Session,
    info: *const machine.Info,
    config_path: []const u8,
    /// While a connect waits for the browser, its page (to open again instead of starting another).
    active: std.atomic.Value(bool) = .init(false),
    url: [512]u8 = undefined,
    url_len: usize = 0,

    /// Opens Profile → Processing to connect; a second call while one waits opens the same page again.
    pub fn start(c: *Connector) void {
        if (c.active.load(.acquire)) {
            _ = platform.open(c.gpa, c.io, c.url[0..c.url_len]);
            return;
        }
        c.active.store(true, .release);
        const t = std.Thread.spawn(.{}, run, .{c}) catch |err| {
            log.say(c.io, "connecting could not start ({s})", .{@errorName(err)});
            c.active.store(false, .release);
            return;
        };
        t.detach();
    }

    fn run(c: *Connector) void {
        defer c.active.store(false, .release);
        const io = c.io;
        var addr = Io.net.IpAddress.parseIp4("127.0.0.1", 0) catch return;
        var server = addr.listen(io, .{}) catch |err| {
            log.say(io, "connecting failed: no local port ({s})", .{@errorName(err)});
            return;
        };
        defer server.deinit(io);
        var secret_bytes: [16]u8 = undefined;
        io.random(&secret_bytes);
        var secret_buf: [32]u8 = undefined;
        const secret = std.fmt.bufPrint(&secret_buf, "{x}", .{&secret_bytes}) catch return;
        var web_buf: [300]u8 = undefined;
        const web = c.session.webBase(io, &web_buf);
        const url = std.fmt.bufPrint(&c.url, "{s}/profile?helper-port={d}&helper-state={s}", .{ web, server.socket.address.getPort(), secret }) catch return;
        c.url_len = url.len;
        log.say(io, "connecting: {s}", .{url});
        if (!platform.open(c.gpa, io, url)) log.say(io, "open this page in your browser to connect: {s}", .{url});

        // A watchdog ends the wait: closing the listening socket makes the pending accept fail.
        var waiting = std.atomic.Value(bool).init(true);
        const watchdog = std.Thread.spawn(.{}, struct {
            fn f(s: *Io.net.Server, i: Io, w: *std.atomic.Value(bool)) void {
                var slept: u64 = 0;
                while (w.load(.acquire) and slept < wait_ms) : (slept += 500) i.sleep(.fromMilliseconds(500), .awake) catch return;
                if (w.load(.acquire)) {
                    log.say(i, "connecting: no answer from the browser in 10 minutes; connect again from the tray", .{});
                    s.socket.close(i);
                }
            }
        }.f, .{ &server, io, &waiting }) catch null;
        defer {
            waiting.store(false, .release);
            if (watchdog) |w| w.join();
        }

        while (true) {
            const stream = server.accept(io) catch return;
            defer stream.close(io);
            if (c.handle(stream, secret)) return;
        }
    }

    /// One browser request. True once the agent is paired (the wait ends).
    fn handle(c: *Connector, stream: Io.net.Stream, secret: []const u8) bool {
        const io = c.io;
        var in_buf: [8192]u8 = undefined;
        var out_buf: [4096]u8 = undefined;
        var reader = stream.reader(io, &in_buf);
        var writer = stream.writer(io, &out_buf);
        var http: std.http.Server = .init(&reader.interface, &writer.interface);
        var request = http.receiveHead() catch return false;
        var arena: std.heap.ArenaAllocator = .init(c.gpa);
        defer arena.deinit();
        const a = arena.allocator();
        const q = parseTarget(a, request.head.target) catch {
            text(&request, .bad_request, "Bad request");
            return false;
        };
        if (!std.mem.eql(u8, q.path, "/pair")) {
            text(&request, .not_found, "Not found");
            return false;
        }
        if (!std.mem.eql(u8, q.state, secret)) {
            text(&request, .forbidden, "This link is not for this Direct360 Helper Agent.");
            return false;
        }
        const current = c.session.creds(io, a) catch return false;
        // The page that issued the code says which server and site it belongs to: the agent pairs there.
        const server = httpUrl(q.server) orelse current.server;
        const web = httpUrl(q.web) orelse current.web;
        var api = Api.init(c.gpa, io, server, "");
        defer api.deinit();
        const token = pair: {
            const r = api.post("/local-worker/pair", .{ .code = q.code, .info = c.info.* }) catch |err| {
                log.say(io, "connecting failed: {s}", .{@errorName(err)});
                const msg = std.fmt.allocPrint(a, "Connecting the Direct360 Helper Agent failed: {s}", .{switch (err) {
                    error.ServerRefused => "the code is not valid or has expired. Connect again from the tray.",
                    error.Outdated => "this agent is out of date. Download the new one in Profile → Processing.",
                    else => @errorName(err),
                }}) catch "Connecting the Direct360 Helper Agent failed.";
                text(&request, .bad_request, msg);
                return false;
            };
            defer r.deinit(c.gpa);
            const Paired = struct { token: []const u8 };
            // Copied out of the reply, which is freed when this block ends.
            const p = std.json.parseFromSliceLeaky(Paired, a, r.body, .{ .ignore_unknown_fields = true, .allocate = .alloc_always }) catch return false;
            break :pair p.token;
        };
        config.save(c.gpa, io, c.config_path, .{ .server = server, .token = token, .web = web }) catch |err|
            log.say(io, "the pairing could not be saved ({s}); it lasts until the agent quits", .{@errorName(err)});
        c.session.setCreds(io, server, token, web) catch return false;
        log.say(io, "connected to Direct360 at {s}", .{server});
        var web_buf: [300]u8 = undefined;
        const back = std.fmt.allocPrint(a, "{s}/profile", .{c.session.webBase(io, &web_buf)}) catch return true;
        request.respond("", .{ .status = .found, .keep_alive = false, .extra_headers = &.{.{ .name = "location", .value = back }} }) catch {};
        return true;
    }
};

fn text(request: *std.http.Server.Request, status: std.http.Status, body: []const u8) void {
    request.respond(body, .{ .status = status, .keep_alive = false, .extra_headers = &.{.{ .name = "content-type", .value = "text/plain; charset=utf-8" }} }) catch {};
}

/// An http(s) URL without a trailing slash, or null.
pub fn httpUrl(v: []const u8) ?[]const u8 {
    const s = std.mem.trimEnd(u8, v, "/");
    if (!(std.mem.startsWith(u8, s, "http://") or std.mem.startsWith(u8, s, "https://"))) return null;
    if (std.mem.indexOfAny(u8, s, " \t\r\n") != null) return null;
    return s;
}

pub const Query = struct {
    path: []const u8,
    state: []const u8 = "",
    code: []const u8 = "",
    server: []const u8 = "",
    web: []const u8 = "",
};

/// `/pair?state=…&code=…&server=…&web=…` → its path and the known parameters, percent-decoded.
pub fn parseTarget(a: std.mem.Allocator, target: []const u8) !Query {
    const qmark = std.mem.indexOfScalar(u8, target, '?');
    var q: Query = .{ .path = if (qmark) |i| target[0..i] else target };
    const query = if (qmark) |i| target[i + 1 ..] else return q;
    var pairs = std.mem.splitScalar(u8, query, '&');
    while (pairs.next()) |pair| {
        const eq = std.mem.indexOfScalar(u8, pair, '=') orelse continue;
        const raw = try a.dupe(u8, pair[eq + 1 ..]);
        std.mem.replaceScalar(u8, raw, '+', ' ');
        const value = std.Uri.percentDecodeInPlace(raw);
        const key = pair[0..eq];
        if (std.mem.eql(u8, key, "state")) q.state = value;
        if (std.mem.eql(u8, key, "code")) q.code = value;
        if (std.mem.eql(u8, key, "server")) q.server = value;
        if (std.mem.eql(u8, key, "web")) q.web = value;
    }
    return q;
}

test "the browser's answer: path and parameters, decoded" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const q = try parseTarget(arena.allocator(), "/pair?state=ab12&code=K7PQ-M2XR&server=https%3A%2F%2Fdirect360.app%2Fapi&web=https%3A%2F%2Fdirect360.app");
    try std.testing.expectEqualStrings("/pair", q.path);
    try std.testing.expectEqualStrings("ab12", q.state);
    try std.testing.expectEqualStrings("K7PQ-M2XR", q.code);
    try std.testing.expectEqualStrings("https://direct360.app/api", q.server);
    try std.testing.expectEqualStrings("https://direct360.app", httpUrl(q.web).?);
    try std.testing.expect(httpUrl("javascript:alert(1)") == null);
    try std.testing.expectEqualStrings("/favicon.ico", (try parseTarget(arena.allocator(), "/favicon.ico")).path);
}
