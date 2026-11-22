//! The Linux tray icon and its menu, as on Windows: the lens mark (white, for the dark top bar of Ubuntu and most
//! desktops; pulsing while a job runs) and a menu with the version, the status (after an LED like the web app's), the running jobs, Connect to
//! Direct360… and Enter connection code… (Disconnect once connected), Open Direct360, Start when the computer starts, Show log and Quit. It is an AppIndicator
//! (libayatana-appindicator3 with GTK 3), loaded when the tray starts, so the agent itself still runs without them
//! (--headless). Runs the GTK main loop on the calling thread until Quit.
const std = @import("std");
const Io = std.Io;
const connect = @import("connect.zig");
const job = @import("job.zig");
const jobs = @import("jobs.zig");
const log = @import("log.zig");
const machine = @import("machine.zig");
const platform = @import("platform.zig");
const sess = @import("session.zig");

pub const Tray = struct {
    gpa: std.mem.Allocator,
    io: Io,
    session: *sess.Session,
    table: *jobs.Table,
    connector: *connect.Connector,
    log_path: ?[]const u8,
    exe_path: []const u8,
    show_log: bool,
    /// HOME, for the icons (~/.cache) and the autostart entry (~/.config/autostart).
    home: []const u8 = "",
    cache_home: ?[]const u8 = null,
    config_home: ?[]const u8 = null,
};

const Widget = opaque {};
const Indicator = opaque {};
const Pixbuf = opaque {};
const Callback = *const fn (*Widget, ?*anyopaque) callconv(.c) void;
const SourceFn = *const fn (?*anyopaque) callconv(.c) c_int;
const FdFn = *const fn (c_int, c_uint, ?*anyopaque) callconv(.c) c_int;

/// The GTK, GLib and AppIndicator functions the tray uses, looked up when it starts.
const Lib = struct {
    gtk_init_check: *const fn (?*c_int, ?*anyopaque) callconv(.c) c_int,
    gtk_main: *const fn () callconv(.c) void,
    gtk_main_quit: *const fn () callconv(.c) void,
    gtk_menu_new: *const fn () callconv(.c) *Widget,
    gtk_menu_item_new_with_label: *const fn ([*:0]const u8) callconv(.c) *Widget,
    gtk_check_menu_item_new_with_label: *const fn ([*:0]const u8) callconv(.c) *Widget,
    gtk_image_menu_item_new_with_label: *const fn ([*:0]const u8) callconv(.c) *Widget,
    gtk_image_menu_item_set_image: *const fn (*Widget, *Widget) callconv(.c) void,
    gtk_image_menu_item_set_always_show_image: *const fn (*Widget, c_int) callconv(.c) void,
    gtk_image_new_from_pixbuf: *const fn (*Pixbuf) callconv(.c) *Widget,
    gtk_image_set_from_pixbuf: *const fn (*Widget, *Pixbuf) callconv(.c) void,
    gdk_pixbuf_new: *const fn (c_int, c_int, c_int, c_int, c_int) callconv(.c) ?*Pixbuf,
    gdk_pixbuf_get_pixels: *const fn (*Pixbuf) callconv(.c) [*]u8,
    gdk_pixbuf_get_rowstride: *const fn (*Pixbuf) callconv(.c) c_int,
    g_object_unref: *const fn (*anyopaque) callconv(.c) void,
    gtk_separator_menu_item_new: *const fn () callconv(.c) *Widget,
    gtk_menu_shell_append: *const fn (*Widget, *Widget) callconv(.c) void,
    gtk_widget_show_all: *const fn (*Widget) callconv(.c) void,
    gtk_widget_set_visible: *const fn (*Widget, c_int) callconv(.c) void,
    gtk_menu_item_set_label: *const fn (*Widget, [*:0]const u8) callconv(.c) void,
    gtk_check_menu_item_set_active: *const fn (*Widget, c_int) callconv(.c) void,
    gtk_check_menu_item_get_active: *const fn (*Widget) callconv(.c) c_int,
    g_signal_connect_data: *const fn (*anyopaque, [*:0]const u8, *const anyopaque, ?*anyopaque, ?*anyopaque, c_int) callconv(.c) c_ulong,
    g_timeout_add: *const fn (c_uint, SourceFn, ?*anyopaque) callconv(.c) c_uint,
    g_idle_add: *const fn (SourceFn, ?*anyopaque) callconv(.c) c_uint,
    gtk_dialog_new: *const fn () callconv(.c) *Widget,
    gtk_dialog_add_button: *const fn (*Widget, [*:0]const u8, c_int) callconv(.c) *Widget,
    gtk_dialog_get_content_area: *const fn (*Widget) callconv(.c) *Widget,
    gtk_dialog_set_default_response: *const fn (*Widget, c_int) callconv(.c) void,
    gtk_dialog_run: *const fn (*Widget) callconv(.c) c_int,
    gtk_entry_new: *const fn () callconv(.c) *Widget,
    gtk_entry_get_text: *const fn (*Widget) callconv(.c) [*:0]const u8,
    gtk_entry_set_activates_default: *const fn (*Widget, c_int) callconv(.c) void,
    gtk_label_new: *const fn ([*:0]const u8) callconv(.c) *Widget,
    gtk_label_set_line_wrap: *const fn (*Widget, c_int) callconv(.c) void,
    gtk_container_add: *const fn (*Widget, *Widget) callconv(.c) void,
    gtk_container_set_border_width: *const fn (*Widget, c_uint) callconv(.c) void,
    gtk_box_set_spacing: *const fn (*Widget, c_int) callconv(.c) void,
    gtk_window_set_title: *const fn (*Widget, [*:0]const u8) callconv(.c) void,
    gtk_window_set_keep_above: *const fn (*Widget, c_int) callconv(.c) void,
    gtk_window_set_position: *const fn (*Widget, c_int) callconv(.c) void,
    gtk_widget_destroy: *const fn (*Widget) callconv(.c) void,
    g_unix_fd_add: *const fn (c_int, c_uint, FdFn, ?*anyopaque) callconv(.c) c_uint,
    app_indicator_new_with_path: *const fn ([*:0]const u8, [*:0]const u8, c_int, [*:0]const u8) callconv(.c) ?*Indicator,
    app_indicator_set_status: *const fn (*Indicator, c_int) callconv(.c) void,
    app_indicator_set_menu: *const fn (*Indicator, *Widget) callconv(.c) void,
    app_indicator_set_icon_full: *const fn (*Indicator, [*:0]const u8, [*:0]const u8) callconv(.c) void,
    app_indicator_set_title: *const fn (*Indicator, [*:0]const u8) callconv(.c) void,
};

const libraries = [_][:0]const u8{ "libayatana-appindicator3.so.1", "libgtk-3.so.0", "libgdk_pixbuf-2.0.so.0", "libgobject-2.0.so.0", "libglib-2.0.so.0" };

fn load() !Lib {
    var handles: [libraries.len]std.DynLib = undefined;
    for (libraries, 0..) |name, i| handles[i] = std.DynLib.openZ(name) catch {
        log.say(tray.io, "{s} is missing", .{name});
        return if (i == 0) error.AppIndicatorMissing else error.GtkMissing;
    };
    var lib: Lib = undefined;
    const info = @typeInfo(Lib).@"struct";
    inline for (info.field_names, info.field_types) |name, T| {
        const found = for (&handles) |*h| {
            if (h.lookup(T, name)) |p| break p;
        } else null;
        @field(lib, name) = found orelse {
            log.say(tray.io, "{s} is not in the GTK/AppIndicator libraries", .{name});
            return error.GtkMissing;
        };
    }
    return lib;
}

const icon_white = @embedFile("tray_white_png");
const icon_white_dim = @embedFile("tray_white_dim_png");
const ICON = "direct360-agent-tray";
const ICON_DIM = "direct360-agent-tray-dim";
const PULSE_MS = 700;
const AUTOSTART_FILE = "direct360-agent.desktop";

var tray: *Tray = undefined;
var gtk: Lib = undefined;
var indicator: *Indicator = undefined;
var item_status: *Widget = undefined;
var led_image: *Widget = undefined;
var last_led: ?u32 = null;
var item_jobs: [jobs.slots]*Widget = undefined;
var item_connect: *Widget = undefined;
var item_code: *Widget = undefined;
var item_disconnect: *Widget = undefined;
var item_autostart: *Widget = undefined;
var dim = false;
var last_status: [200]u8 = undefined;
var last_status_len: usize = 0;
var last_unpaired: ?bool = null;
var last_jobs: [jobs.slots][96]u8 = undefined;
var last_jobs_len: [jobs.slots]?usize = @splat(null);

fn busy() bool {
    return tray.table.count(tray.io) > 0;
}

fn statusLine(buf: []u8) []const u8 {
    const s = tray.session.snapshot(tray.io);
    return switch (s.status) {
        .unpaired => "Not connected to Direct360",
        .starting => "Starting…",
        .ready => if (busy()) "Working" else "Ready",
        .unreachable_server => std.fmt.bufPrint(buf, "Server not reached: {s}", .{s.messageSlice()}) catch "Server not reached",
        .outdated => "Update the Direct360 Helper Agent",
        .stopped => std.fmt.bufPrint(buf, "Stopped: {s}", .{s.messageSlice()}) catch "Stopped",
    };
}

/// The status LED's colour, as on Windows (0xRRGGBB): green ready (the web app's LED green), blue working, amber
/// starting, grey not connected, red when something is wrong.
fn statusColor() u32 {
    return switch (tray.session.snapshot(tray.io).status) {
        .ready => if (busy()) 0x1E88E5 else 0x00FF3C,
        .starting => 0xF5A623,
        .unpaired => 0x9E9E9E,
        .unreachable_server, .outdated, .stopped => 0xE53935,
    };
}

const LED_PX = 32;

/// The status LED, as on Windows and in the Direct360 web app: a thin flat dash with square ends and a soft glow,
/// smooth at the edges (4×4 samples per pixel), in a LED_PX square with transparency.
fn ledPixbuf(color: u32) ?*Pixbuf {
    const GDK_COLORSPACE_RGB = 0;
    const pb = gtk.gdk_pixbuf_new(GDK_COLORSPACE_RGB, 1, 8, LED_PX, LED_PX) orelse return null;
    const px = gtk.gdk_pixbuf_get_pixels(pb);
    const stride: usize = @intCast(gtk.gdk_pixbuf_get_rowstride(pb));
    const sf: f32 = LED_PX;
    const hh = sf * 0.09; // half the dash's height
    const half = sf * 0.30; // half its length
    const glow = sf * 0.10;
    const c = sf / 2;
    for (0..LED_PX) |row| {
        for (0..LED_PX) |col| {
            var inside: f32 = 0;
            var halo: f32 = 0;
            for (0..4) |sy| {
                for (0..4) |sx| {
                    const fx = @as(f32, @floatFromInt(col)) + (@as(f32, @floatFromInt(sx)) + 0.5) / 4 - c;
                    const fy = @as(f32, @floatFromInt(row)) + (@as(f32, @floatFromInt(sy)) + 0.5) / 4 - c;
                    // Distance to the dash's edge (negative inside); square ends.
                    const dx = @abs(fx) - half;
                    const dy = @abs(fy) - hh;
                    const ox = @max(dx, 0);
                    const oy = @max(dy, 0);
                    const d = if (dx <= 0 and dy <= 0) @max(dx, dy) else @sqrt(ox * ox + oy * oy);
                    // The glow fades out before the square's edges, so no box shows around it.
                    const edge = @min(c - @abs(fx), c - @abs(fy)) / (sf * 0.18);
                    if (d <= 0) inside += 1 else halo += @exp(-d / glow) * std.math.clamp(edge, 0, 1);
                }
            }
            const cov = inside / 16;
            const a = cov + (1 - cov) * (halo / 16) * 0.55;
            const p = px + row * stride + col * 4;
            p[0] = @truncate(color >> 16);
            p[1] = @truncate(color >> 8);
            p[2] = @truncate(color);
            p[3] = @intFromFloat(@min(255, a * 255));
        }
    }
    return pb;
}

fn setLed(color: u32) void {
    if (last_led == color) return;
    const pb = ledPixbuf(color) orelse return;
    defer gtk.g_object_unref(pb);
    gtk.gtk_image_set_from_pixbuf(led_image, pb);
    last_led = color;
}

fn setLabel(w: *Widget, text: []const u8) void {
    var buf: [300]u8 = undefined;
    const z = std.fmt.bufPrintSentinel(&buf, "{s}", .{text}, 0) catch return;
    gtk.gtk_menu_item_set_label(w, z.ptr);
}

/// The menu's status, jobs and connect lines; each is changed only when its text changed.
fn refresh() void {
    var buf: [200]u8 = undefined;
    const status = statusLine(&buf);
    if (!std.mem.eql(u8, status, last_status[0..last_status_len])) {
        setLabel(item_status, status);
        const n = @min(status.len, last_status.len);
        @memcpy(last_status[0..n], status[0..n]);
        last_status_len = n;
    }
    setLed(statusColor());
    const unpaired = tray.session.snapshot(tray.io).status == .unpaired;
    if (last_unpaired != unpaired) {
        // Connected: Disconnect only; not connected: the two ways to connect.
        gtk.gtk_widget_set_visible(item_connect, @intFromBool(unpaired));
        gtk.gtk_widget_set_visible(item_code, @intFromBool(unpaired));
        gtk.gtk_widget_set_visible(item_disconnect, @intFromBool(!unpaired));
        last_unpaired = unpaired;
    }
    for (0..jobs.slots) |i| {
        const e = tray.table.snapshot(tray.io, i);
        var line: [96]u8 = undefined;
        const text: ?[]const u8 = if (!e.used) null else blk: {
            const name = if (e.phase_len > 0) e.phase[0..e.phase_len] else e.task[0..e.task_len];
            break :blk if (e.progress) |p| std.fmt.bufPrint(&line, "     {s} {d:.0}%", .{ name, p }) catch name else std.fmt.bufPrint(&line, "     {s}", .{name}) catch name;
        };
        const same = if (text) |t| (last_jobs_len[i] != null and std.mem.eql(u8, t, last_jobs[i][0..last_jobs_len[i].?])) else last_jobs_len[i] == null;
        if (same) continue;
        if (text) |t| {
            setLabel(item_jobs[i], t);
            @memcpy(last_jobs[i][0..t.len], t);
            last_jobs_len[i] = t.len;
        } else {
            last_jobs_len[i] = null;
        }
        gtk.gtk_widget_set_visible(item_jobs[i], @intFromBool(text != null));
    }
}

fn onTimer(_: ?*anyopaque) callconv(.c) c_int {
    const was_dim = dim;
    dim = if (busy()) !dim else false;
    if (dim != was_dim) gtk.app_indicator_set_icon_full(indicator, if (dim) ICON_DIM else ICON, "Direct360 Helper Agent");
    refresh();
    return 1;
}

fn onConnect(_: *Widget, _: ?*anyopaque) callconv(.c) void {
    tray.connector.start();
}

/// Tray → Disconnect: forgets the pairing; a job running now finishes, then no more are taken.
fn onDisconnect(_: *Widget, _: ?*anyopaque) callconv(.c) void {
    if (!tray.connector.disconnect()) showResult("Disconnecting failed: the pairing could not be saved. See the log.");
    refresh();
}

const GTK_RESPONSE_OK = -5;
const GTK_RESPONSE_CANCEL = -6;
const GTK_WIN_POS_CENTER = 1;
var code_dialog_open = false;

/// A dialog with `text` and its buttons, centred and on top; the caller adds the rest and runs it.
fn dialog(text: [*:0]const u8) struct { d: *Widget, box: *Widget } {
    const d = gtk.gtk_dialog_new();
    gtk.gtk_window_set_title(d, "Direct360 Helper Agent");
    gtk.gtk_window_set_keep_above(d, 1);
    gtk.gtk_window_set_position(d, GTK_WIN_POS_CENTER);
    const box = gtk.gtk_dialog_get_content_area(d);
    gtk.gtk_container_set_border_width(box, 12);
    gtk.gtk_box_set_spacing(box, 10);
    const label = gtk.gtk_label_new(text);
    gtk.gtk_label_set_line_wrap(label, 1);
    gtk.gtk_container_add(box, label);
    return .{ .d = d, .box = box };
}

/// Tray → Enter connection code…: asks for the code from Direct360 → Settings → Processing and pairs with it on
/// another thread; the result is shown either way.
fn onCode(_: *Widget, _: ?*anyopaque) callconv(.c) void {
    if (code_dialog_open) return;
    code_dialog_open = true;
    defer code_dialog_open = false;
    const w = dialog("Connection code from Direct360 → Settings → Processing:");
    const entry = gtk.gtk_entry_new();
    gtk.gtk_entry_set_activates_default(entry, 1);
    gtk.gtk_container_add(w.box, entry);
    _ = gtk.gtk_dialog_add_button(w.d, "Cancel", GTK_RESPONSE_CANCEL);
    _ = gtk.gtk_dialog_add_button(w.d, "Connect", GTK_RESPONSE_OK);
    gtk.gtk_dialog_set_default_response(w.d, GTK_RESPONSE_OK);
    gtk.gtk_widget_show_all(w.d);
    const answer = gtk.gtk_dialog_run(w.d);
    // The entry's text belongs to the dialog: copied before it goes.
    const typed = std.mem.trim(u8, std.mem.span(gtk.gtk_entry_get_text(entry)), " \t");
    const code = if (answer == GTK_RESPONSE_OK and typed.len > 0) tray.gpa.dupe(u8, typed) catch null else null;
    gtk.gtk_widget_destroy(w.d);
    const c = code orelse return;
    const t = std.Thread.spawn(.{}, pairWithCode, .{c}) catch |err| {
        tray.gpa.free(c);
        log.say(tray.io, "connecting with a code could not start ({s})", .{@errorName(err)});
        showResult("Connecting could not start.");
        return;
    };
    t.detach();
}

fn pairWithCode(code: []u8) void {
    defer tray.gpa.free(code);
    var arena: std.heap.ArenaAllocator = .init(tray.gpa);
    defer arena.deinit();
    log.say(tray.io, "connecting with a code typed in the tray", .{});
    const why = tray.connector.pairCode(arena.allocator(), code);
    // Shown by the GTK thread; the text is freed there.
    const text = if (why) |m| std.fmt.allocPrintSentinel(tray.gpa, "Connecting failed: {s}", .{m}, 0) else std.fmt.allocPrintSentinel(tray.gpa, "Connected to Direct360.", .{}, 0);
    const t = text catch {
        log.say(tray.io, "the connect result could not be shown (out of memory)", .{});
        return;
    };
    _ = gtk.g_idle_add(onResult, t.ptr);
}

fn onResult(p: ?*anyopaque) callconv(.c) c_int {
    const text: [*:0]u8 = @ptrCast(p.?);
    showResult(text);
    tray.gpa.free(std.mem.span(text)); // a sentinel slice: freed with its 0
    return 0;
}

fn showResult(text: [*:0]const u8) void {
    const w = dialog(text);
    _ = gtk.gtk_dialog_add_button(w.d, "OK", GTK_RESPONSE_OK);
    gtk.gtk_widget_show_all(w.d);
    _ = gtk.gtk_dialog_run(w.d);
    gtk.gtk_widget_destroy(w.d);
}

fn onOpen(_: *Widget, _: ?*anyopaque) callconv(.c) void {
    var web_buf: [300]u8 = undefined;
    var url_buf: [320]u8 = undefined;
    const url = std.fmt.bufPrint(&url_buf, "{s}" ++ connect.settings_path, .{tray.session.webBase(tray.io, &web_buf)}) catch return;
    _ = platform.open(tray.gpa, tray.io, url);
}

fn onLog(_: *Widget, _: ?*anyopaque) callconv(.c) void {
    const p = tray.log_path orelse return;
    if (!platform.open(tray.gpa, tray.io, p)) log.say(tray.io, "the log could not be opened: {s}", .{p});
}

fn onAutostart(w: *Widget, _: ?*anyopaque) callconv(.c) void {
    setAutostart(gtk.gtk_check_menu_item_get_active(w) != 0);
}

fn onQuit(_: *Widget, _: ?*anyopaque) callconv(.c) void {
    job.stopAll();
    gtk.gtk_main_quit();
}

/// A second copy of the agent was started: show the connect page if this one is not connected.
fn onPoke(_: c_int, _: c_uint, _: ?*anyopaque) callconv(.c) c_int {
    platform.takePoke();
    if (tray.session.snapshot(tray.io).status == .unpaired) tray.connector.start();
    return 1;
}

/// ~/.config/autostart/direct360-agent.desktop (XDG_CONFIG_HOME when set).
fn autostartPath(buf: []u8) ?[]const u8 {
    if (tray.config_home) |c| return std.fmt.bufPrint(buf, "{s}/autostart/" ++ AUTOSTART_FILE, .{c}) catch null;
    return std.fmt.bufPrint(buf, "{s}/.config/autostart/" ++ AUTOSTART_FILE, .{tray.home}) catch null;
}

fn autostart() bool {
    var buf: [1024]u8 = undefined;
    const p = autostartPath(&buf) orelse return false;
    Io.Dir.cwd().access(tray.io, p, .{}) catch return false;
    return true;
}

fn setAutostart(on: bool) void {
    var buf: [1024]u8 = undefined;
    const p = autostartPath(&buf) orelse return;
    if (!on) {
        Io.Dir.cwd().deleteFile(tray.io, p) catch {};
        return;
    }
    Io.Dir.cwd().createDirPath(tray.io, std.fs.path.dirname(p) orelse ".") catch {};
    var text_buf: [3000]u8 = undefined;
    // TryExec: once the agent is uninstalled, the entry is skipped.
    const text = std.fmt.bufPrint(&text_buf,
        \\[Desktop Entry]
        \\Type=Application
        \\Name=Direct360 Helper Agent
        \\Exec="{s}"
        \\TryExec={s}
        \\Icon=direct360-agent
        \\Terminal=false
        \\X-GNOME-Autostart-enabled=true
        \\
    , .{ tray.exe_path, tray.exe_path }) catch return;
    Io.Dir.cwd().writeFile(tray.io, .{ .sub_path = p, .data = text }) catch |err| log.say(tray.io, "autostart not set: {s} ({s})", .{ p, @errorName(err) });
}

/// The icons as files, which the AppIndicator needs: ~/.cache/direct360-agent/icons (XDG_CACHE_HOME when set).
fn writeIcons(buf: []u8) ![:0]const u8 {
    const dir = if (tray.cache_home) |c|
        try std.fmt.bufPrintSentinel(buf, "{s}/direct360-agent/icons", .{c}, 0)
    else
        try std.fmt.bufPrintSentinel(buf, "{s}/.cache/direct360-agent/icons", .{tray.home}, 0);
    const io = tray.io;
    try Io.Dir.cwd().createDirPath(io, dir);
    var path_buf: [1100]u8 = undefined;
    try Io.Dir.cwd().writeFile(io, .{ .sub_path = try std.fmt.bufPrint(&path_buf, "{s}/" ++ ICON ++ ".png", .{dir}), .data = icon_white });
    try Io.Dir.cwd().writeFile(io, .{ .sub_path = try std.fmt.bufPrint(&path_buf, "{s}/" ++ ICON_DIM ++ ".png", .{dir}), .data = icon_white_dim });
    return dir;
}

/// `text` in Unicode's sans-serif bold letters and digits (other characters as they are). GNOME's tray menu shows
/// plain text only, so this is how the name line is bold, as on Windows.
fn bold(comptime text: []const u8) [:0]const u8 {
    comptime {
        var out: []const u8 = "";
        for (text) |ch| {
            const cp: ?u21 = switch (ch) {
                'A'...'Z' => 0x1D5D4 + @as(u21, ch - 'A'),
                'a'...'z' => 0x1D5EE + @as(u21, ch - 'a'),
                '0'...'9' => 0x1D7EC + @as(u21, ch - '0'),
                else => null,
            };
            if (cp) |c| {
                var buf: [4]u8 = undefined;
                const n = std.unicode.utf8Encode(c, &buf) catch unreachable;
                out = out ++ buf[0..n];
            } else out = out ++ .{ch};
        }
        const final = out[0..out.len].* ++ .{0};
        return final[0..out.len :0];
    }
}

/// The version, status and job lines do nothing when clicked. They stay enabled, so they are drawn in the normal
/// text colour: GNOME draws a disabled line grey, and the status would look switched off.
fn onInfo(_: *Widget, _: ?*anyopaque) callconv(.c) void {}

fn item(menu: *Widget, label: [*:0]const u8, on_activate: ?Callback) *Widget {
    const w = gtk.gtk_menu_item_new_with_label(label);
    _ = gtk.g_signal_connect_data(w, "activate", @ptrCast(on_activate orelse &onInfo), null, null, 0);
    gtk.gtk_menu_shell_append(menu, w);
    return w;
}

fn separator(menu: *Widget) void {
    gtk.gtk_menu_shell_append(menu, gtk.gtk_separator_menu_item_new());
}

/// Another copy is already running: tell it (it shows the connect page if it is not connected).
pub fn pokeRunningCopy() void {
    platform.pokeRunningCopy();
}

/// Shows the tray icon and runs the GTK main loop until Quit. Errors when the libraries or the display are missing.
pub fn run(t: *Tray) !void {
    tray = t;
    gtk = try load();
    if (gtk.gtk_init_check(null, null) == 0) return error.NoDisplay;
    var dir_buf: [1024]u8 = undefined;
    const icon_dir = try writeIcons(&dir_buf);
    const APP_INDICATOR_CATEGORY_APPLICATION_STATUS = 0;
    const APP_INDICATOR_STATUS_ACTIVE = 1;
    indicator = gtk.app_indicator_new_with_path("direct360-agent", ICON, APP_INDICATOR_CATEGORY_APPLICATION_STATUS, icon_dir.ptr) orelse return error.TrayIndicator;
    gtk.app_indicator_set_title(indicator, "Direct360 Helper Agent");

    const menu = gtk.gtk_menu_new();
    _ = item(menu, comptime bold("Direct360 Helper Agent " ++ machine.version), null);
    // The status after the LED, as on Windows.
    item_status = gtk.gtk_image_menu_item_new_with_label("Starting…");
    _ = gtk.g_signal_connect_data(item_status, "activate", @ptrCast(&onInfo), null, null, 0);
    const led = ledPixbuf(statusColor()) orelse return error.GtkMissing;
    led_image = gtk.gtk_image_new_from_pixbuf(led);
    gtk.g_object_unref(led);
    last_led = statusColor();
    gtk.gtk_image_menu_item_set_image(item_status, led_image);
    gtk.gtk_image_menu_item_set_always_show_image(item_status, 1);
    gtk.gtk_menu_shell_append(menu, item_status);
    for (&item_jobs) |*w| w.* = item(menu, "", null);
    separator(menu);
    item_connect = item(menu, "Connect to Direct360…", onConnect);
    item_code = item(menu, "Enter connection code…", onCode);
    item_disconnect = item(menu, "Disconnect", onDisconnect);
    _ = item(menu, "Open Direct360", onOpen);
    separator(menu);
    item_autostart = gtk.gtk_check_menu_item_new_with_label("Start when the computer starts");
    gtk.gtk_check_menu_item_set_active(item_autostart, @intFromBool(autostart()));
    _ = gtk.g_signal_connect_data(item_autostart, "activate", @ptrCast(&onAutostart), null, null, 0);
    gtk.gtk_menu_shell_append(menu, item_autostart);
    separator(menu);
    if (t.show_log) _ = item(menu, "Show log", onLog);
    _ = item(menu, "Quit", onQuit);
    gtk.gtk_widget_show_all(menu);
    for (item_jobs) |w| gtk.gtk_widget_set_visible(w, 0);
    refresh();

    gtk.app_indicator_set_menu(indicator, menu);
    gtk.app_indicator_set_status(indicator, APP_INDICATOR_STATUS_ACTIVE);
    _ = gtk.g_timeout_add(PULSE_MS, onTimer, null);
    const G_IO_IN = 1;
    if (platform.instance_socket) |fd| _ = gtk.g_unix_fd_add(fd, G_IO_IN, onPoke, null);
    log.say(t.io, "tray icon ready", .{});
    gtk.gtk_main();
}
