//! The Windows tray icon and its menu, as in direct360-helper 2.0.4: the lens mark (black on a light taskbar, white on
//! a dark one, pulsing while a job runs), a tooltip with the status, and a menu with the version, the status, the
//! running jobs, Connect to Direct360…, Open Direct360, Start when the computer starts, Show log and Quit.
//! Runs the window message loop on the calling thread until Quit.
const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const windows = std.os.windows;
const connect = @import("connect.zig");
const jobs = @import("jobs.zig");
const log = @import("log.zig");
const machine = @import("machine.zig");
const platform = @import("platform.zig");
const sess = @import("session.zig");

const L = std.unicode.utf8ToUtf16LeStringLiteral;
const HWND = windows.HWND;
const HICON = windows.HICON;
const HMENU = windows.HMENU;
const HINSTANCE = windows.HINSTANCE;
const WPARAM = usize;
const LPARAM = isize;
const LRESULT = isize;

const POINT = extern struct { x: i32, y: i32 };
const MSG = extern struct { hwnd: ?HWND, message: u32, wParam: WPARAM, lParam: LPARAM, time: u32, pt: POINT, private: u32 };
const WNDPROC = *const fn (HWND, u32, WPARAM, LPARAM) callconv(.winapi) LRESULT;
const WNDCLASSEXW = extern struct {
    cbSize: u32 = @sizeOf(WNDCLASSEXW),
    style: u32 = 0,
    lpfnWndProc: WNDPROC,
    cbClsExtra: i32 = 0,
    cbWndExtra: i32 = 0,
    hInstance: ?HINSTANCE,
    hIcon: ?HICON = null,
    hCursor: ?*anyopaque = null,
    hbrBackground: ?*anyopaque = null,
    lpszMenuName: ?[*:0]const u16 = null,
    lpszClassName: [*:0]const u16,
    hIconSm: ?HICON = null,
};
const GUID = extern struct { a: u32 = 0, b: u16 = 0, c: u16 = 0, d: [8]u8 = @splat(0) };
const NOTIFYICONDATAW = extern struct {
    cbSize: u32 = @sizeOf(NOTIFYICONDATAW),
    hWnd: ?HWND = null,
    uID: u32 = 1,
    uFlags: u32 = 0,
    uCallbackMessage: u32 = 0,
    hIcon: ?HICON = null,
    szTip: [128]u16 = @splat(0),
    dwState: u32 = 0,
    dwStateMask: u32 = 0,
    szInfo: [256]u16 = @splat(0),
    uVersion: u32 = 0,
    szInfoTitle: [64]u16 = @splat(0),
    dwInfoFlags: u32 = 0,
    guidItem: GUID = .{},
    hBalloonIcon: ?HICON = null,
};

extern "user32" fn RegisterClassExW(*const WNDCLASSEXW) callconv(.winapi) u16;
extern "user32" fn CreateWindowExW(ex: u32, class: [*:0]const u16, name: [*:0]const u16, style: u32, x: i32, y: i32, w: i32, h: i32, parent: ?HWND, menu: ?HMENU, inst: ?HINSTANCE, param: ?*anyopaque) callconv(.winapi) ?HWND;
extern "user32" fn DefWindowProcW(HWND, u32, WPARAM, LPARAM) callconv(.winapi) LRESULT;
extern "user32" fn GetMessageW(*MSG, ?HWND, u32, u32) callconv(.winapi) i32;
extern "user32" fn TranslateMessage(*const MSG) callconv(.winapi) i32;
extern "user32" fn DispatchMessageW(*const MSG) callconv(.winapi) LRESULT;
extern "user32" fn PostQuitMessage(i32) callconv(.winapi) void;
extern "user32" fn PostMessageW(?HWND, u32, WPARAM, LPARAM) callconv(.winapi) i32;
extern "user32" fn CreatePopupMenu() callconv(.winapi) ?HMENU;
extern "user32" fn AppendMenuW(HMENU, u32, usize, ?[*:0]const u16) callconv(.winapi) i32;
extern "user32" fn TrackPopupMenu(HMENU, u32, i32, i32, i32, HWND, ?*anyopaque) callconv(.winapi) i32;
extern "user32" fn DestroyMenu(HMENU) callconv(.winapi) i32;
extern "user32" fn SetForegroundWindow(HWND) callconv(.winapi) i32;
extern "user32" fn GetCursorPos(*POINT) callconv(.winapi) i32;
extern "user32" fn SetTimer(?HWND, usize, u32, ?*anyopaque) callconv(.winapi) usize;
extern "user32" fn LoadImageW(?HINSTANCE, usize, u32, i32, i32, u32) callconv(.winapi) ?*anyopaque;
extern "user32" fn GetSystemMetrics(i32) callconv(.winapi) i32;
extern "user32" fn RegisterWindowMessageW([*:0]const u16) callconv(.winapi) u32;
extern "user32" fn FindWindowW(?[*:0]const u16, ?[*:0]const u16) callconv(.winapi) ?HWND;
extern "shell32" fn Shell_NotifyIconW(u32, *NOTIFYICONDATAW) callconv(.winapi) i32;
extern "kernel32" fn GetModuleHandleW(?[*:0]const u16) callconv(.winapi) ?HINSTANCE;
extern "advapi32" fn RegGetValueW(hkey: usize, sub: [*:0]const u16, value: [*:0]const u16, flags: u32, type_: ?*u32, data: ?*anyopaque, len: ?*u32) callconv(.winapi) i32;
extern "advapi32" fn RegSetKeyValueW(hkey: usize, sub: [*:0]const u16, value: [*:0]const u16, type_: u32, data: ?*const anyopaque, len: u32) callconv(.winapi) i32;
extern "advapi32" fn RegDeleteKeyValueW(hkey: usize, sub: [*:0]const u16, value: [*:0]const u16) callconv(.winapi) i32;

const WM_DESTROY = 0x0002;
const WM_TIMER = 0x0113;
const WM_SETTINGCHANGE = 0x001A;
const WM_NULL = 0x0000;
const WM_LBUTTONUP = 0x0202;
const WM_RBUTTONUP = 0x0205;
const WM_APP = 0x8000;
const WM_TRAY = WM_APP + 1;
/// Posted by a second copy of the agent started while this one runs: show the connect page if not connected.
pub const WM_SECOND_INSTANCE = WM_APP + 2;
const NIM_ADD = 0;
const NIM_MODIFY = 1;
const NIM_DELETE = 2;
const NIF_MESSAGE = 0x1;
const NIF_ICON = 0x2;
const NIF_TIP = 0x4;
const MF_STRING = 0x0;
const MF_GRAYED = 0x1;
const MF_CHECKED = 0x8;
const MF_SEPARATOR = 0x800;
const TPM_RIGHTBUTTON = 0x2;
const TPM_BOTTOMALIGN = 0x20;
const TPM_RETURNCMD = 0x100;
const HKEY_CURRENT_USER: usize = 0x80000001;
const RRF_RT_REG_DWORD = 0x10;
const RRF_RT_REG_SZ = 0x2;
const REG_SZ = 1;
const IMAGE_ICON = 1;
const SM_CXSMICON = 49;
const SM_CYSMICON = 50;
pub const window_class = L("Direct360AgentTray");

const RUN_KEY = L("Software\\Microsoft\\Windows\\CurrentVersion\\Run");
const RUN_VALUE = L("Direct360 Agent");
const PULSE_MS = 700;

const ID_CONNECT = 1;
const ID_OPEN = 2;
const ID_AUTOSTART = 3;
const ID_LOG = 4;
const ID_QUIT = 5;

pub const Tray = struct {
    gpa: std.mem.Allocator,
    io: Io,
    session: *sess.Session,
    table: *jobs.Table,
    connector: *connect.Connector,
    log_path: ?[]const u8,
    exe_path: []const u8,
    show_log: bool,
};

var tray: *Tray = undefined;
var hwnd_main: ?HWND = null;
var taskbar_created: u32 = 0;
var icons: [4]?HICON = @splat(null);
var dim = false;
var last_tip: [128]u16 = @splat(0);

fn icon(dark_taskbar: bool, faint: bool) ?HICON {
    const i: usize = @as(usize, @intFromBool(dark_taskbar)) * 2 + @intFromBool(faint);
    if (icons[i] == null) {
        const id: usize = 101 + i; // resources.rc: 101 black, 102 black dim, 103 white, 104 white dim
        icons[i] = @ptrCast(LoadImageW(GetModuleHandleW(null), id, IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0));
    }
    return icons[i];
}

/// The taskbar is dark unless Windows says it uses the light theme.
fn darkTaskbar() bool {
    var value: u32 = 0;
    var len: u32 = @sizeOf(u32);
    const rc = RegGetValueW(HKEY_CURRENT_USER, L("Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize"), L("SystemUsesLightTheme"), RRF_RT_REG_DWORD, null, &value, &len);
    return rc != 0 or value == 0;
}

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
        .outdated => "Update the Direct360 agent",
        .stopped => std.fmt.bufPrint(buf, "Stopped: {s}", .{s.messageSlice()}) catch "Stopped",
    };
}

fn wide(buf: []u16, text: []const u8) [:0]const u16 {
    const n = std.unicode.utf8ToUtf16Le(buf[0 .. buf.len - 1], text) catch 0;
    buf[n] = 0;
    return buf[0..n :0];
}

fn notify(op: u32) void {
    var nid: NOTIFYICONDATAW = .{ .hWnd = hwnd_main, .uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP, .uCallbackMessage = WM_TRAY };
    nid.hIcon = icon(darkTaskbar(), dim and busy());
    var line_buf: [200]u8 = undefined;
    var tip_buf: [256]u8 = undefined;
    const tip = std.fmt.bufPrint(&tip_buf, "Direct360 agent · {s}", .{statusLine(&line_buf)}) catch "Direct360 agent";
    _ = wide(&nid.szTip, tip);
    if (op == NIM_MODIFY and std.mem.eql(u16, &nid.szTip, &last_tip) and !busy()) return;
    last_tip = nid.szTip;
    _ = Shell_NotifyIconW(op, &nid);
}

fn autostart() bool {
    var len: u32 = 0;
    return RegGetValueW(HKEY_CURRENT_USER, RUN_KEY, RUN_VALUE, RRF_RT_REG_SZ, null, null, &len) == 0;
}

fn setAutostart(on: bool) void {
    if (!on) {
        _ = RegDeleteKeyValueW(HKEY_CURRENT_USER, RUN_KEY, RUN_VALUE);
        return;
    }
    var buf: [1100]u8 = undefined;
    const cmd = std.fmt.bufPrint(&buf, "\"{s}\"", .{tray.exe_path}) catch return;
    var wbuf: [1100]u16 = undefined;
    const w = wide(&wbuf, cmd);
    _ = RegSetKeyValueW(HKEY_CURRENT_USER, RUN_KEY, RUN_VALUE, REG_SZ, w.ptr, @intCast((w.len + 1) * 2));
}

fn add(menu: HMENU, flags: u32, id: usize, text: []const u8) void {
    var buf: [300]u16 = undefined;
    _ = AppendMenuW(menu, flags, id, wide(&buf, text).ptr);
}

fn showMenu(hwnd: HWND) void {
    const menu = CreatePopupMenu() orelse return;
    defer _ = DestroyMenu(menu);
    var buf: [200]u8 = undefined;
    add(menu, MF_STRING | MF_GRAYED, 0, "Direct360 agent " ++ machine.version);
    add(menu, MF_STRING | MF_GRAYED, 0, statusLine(&buf));
    for (0..jobs.slots) |i| {
        const e = tray.table.snapshot(tray.io, i);
        if (!e.used) continue;
        var line: [96]u8 = undefined;
        const name = if (e.phase_len > 0) e.phase[0..e.phase_len] else e.task[0..e.task_len];
        const text = if (e.progress) |p| std.fmt.bufPrint(&line, "     {s} {d:.0}%", .{ name, p }) catch name else std.fmt.bufPrint(&line, "     {s}", .{name}) catch name;
        add(menu, MF_STRING | MF_GRAYED, 0, text);
    }
    _ = AppendMenuW(menu, MF_SEPARATOR, 0, null);
    const unpaired = tray.session.snapshot(tray.io).status == .unpaired;
    add(menu, MF_STRING, ID_CONNECT, if (unpaired) "Connect to Direct360…" else "Connect again…");
    add(menu, MF_STRING, ID_OPEN, "Open Direct360");
    _ = AppendMenuW(menu, MF_SEPARATOR, 0, null);
    add(menu, MF_STRING | (if (autostart()) @as(u32, MF_CHECKED) else 0), ID_AUTOSTART, "Start when the computer starts");
    _ = AppendMenuW(menu, MF_SEPARATOR, 0, null);
    if (tray.show_log) add(menu, MF_STRING, ID_LOG, "Show log");
    add(menu, MF_STRING, ID_QUIT, "Quit");

    var pt: POINT = undefined;
    _ = GetCursorPos(&pt);
    _ = SetForegroundWindow(hwnd);
    const cmd = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, pt.x, pt.y, 0, hwnd, null);
    _ = PostMessageW(hwnd, WM_NULL, 0, 0);
    switch (cmd) {
        ID_CONNECT => tray.connector.start(),
        ID_OPEN => {
            var web_buf: [300]u8 = undefined;
            var url_buf: [320]u8 = undefined;
            const url = std.fmt.bufPrint(&url_buf, "{s}/profile", .{tray.session.webBase(tray.io, &web_buf)}) catch return;
            _ = platform.open(tray.gpa, tray.io, url);
        },
        ID_AUTOSTART => setAutostart(!autostart()),
        ID_LOG => if (tray.log_path) |p| {
            if (!platform.open(tray.gpa, tray.io, p)) log.say(tray.io, "the log could not be opened: {s}", .{p});
        },
        ID_QUIT => {
            _ = Shell_NotifyIconW(NIM_DELETE, @constCast(&NOTIFYICONDATAW{ .hWnd = hwnd }));
            PostQuitMessage(0);
        },
        else => {},
    }
}

fn wndProc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) callconv(.winapi) LRESULT {
    switch (msg) {
        WM_TRAY => {
            const event: u32 = @intCast(lparam & 0xFFFF);
            if (event == WM_RBUTTONUP or event == WM_LBUTTONUP) showMenu(hwnd);
            return 0;
        },
        WM_TIMER => {
            if (busy()) dim = !dim else dim = false;
            notify(NIM_MODIFY);
            return 0;
        },
        WM_SETTINGCHANGE => {
            last_tip = @splat(0);
            notify(NIM_MODIFY);
            return 0;
        },
        WM_SECOND_INSTANCE => {
            if (tray.session.snapshot(tray.io).status == .unpaired) tray.connector.start();
            return 0;
        },
        WM_DESTROY => {
            PostQuitMessage(0);
            return 0;
        },
        else => {
            // Explorer restarted: the icon has to be added again.
            if (msg == taskbar_created and taskbar_created != 0) {
                last_tip = @splat(0);
                notify(NIM_ADD);
                return 0;
            }
            return DefWindowProcW(hwnd, msg, wparam, lparam);
        },
    }
}

/// Another copy is already running: tell it (it shows the connect page if it is not connected).
pub fn pokeRunningCopy() void {
    if (FindWindowW(window_class, null)) |h| _ = PostMessageW(h, WM_SECOND_INSTANCE, 0, 0);
}

/// Shows the tray icon and runs the message loop until Quit. Errors only when the window cannot be made.
pub fn run(t: *Tray) !void {
    tray = t;
    const inst = GetModuleHandleW(null);
    const wc: WNDCLASSEXW = .{ .lpfnWndProc = wndProc, .hInstance = inst, .lpszClassName = window_class, .hIcon = @ptrCast(LoadImageW(inst, 1, IMAGE_ICON, 0, 0, 0)) };
    if (RegisterClassExW(&wc) == 0) return error.TrayClass;
    hwnd_main = CreateWindowExW(0, window_class, L("Direct360 agent"), 0, 0, 0, 0, 0, null, null, inst, null) orelse return error.TrayWindow;
    taskbar_created = RegisterWindowMessageW(L("TaskbarCreated"));
    notify(NIM_ADD);
    _ = SetTimer(hwnd_main, 1, PULSE_MS, null);
    log.say(t.io, "tray icon ready", .{});
    var msg: MSG = undefined;
    while (GetMessageW(&msg, null, 0, 0) > 0) {
        _ = TranslateMessage(&msg);
        _ = DispatchMessageW(&msg);
    }
}
