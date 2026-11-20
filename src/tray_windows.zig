//! The Windows tray icon and its menu, as in direct360-helper 2.0.4: the lens mark (black on a light taskbar, white on
//! a dark one, pulsing while a job runs), a tooltip with the status, and a menu with the version, the status, the
//! running jobs, Connect to Direct360…, Enter connection code…, Open Direct360, Start when the computer starts, Show log and Quit.
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
const RECT = extern struct { left: i32, top: i32, right: i32, bottom: i32 };
const LOGFONTW = extern struct {
    height: i32,
    width: i32,
    escapement: i32,
    orientation: i32,
    weight: i32,
    italic: u8,
    underline: u8,
    strike_out: u8,
    char_set: u8,
    out_precision: u8,
    clip_precision: u8,
    quality: u8,
    pitch_and_family: u8,
    face_name: [32]u16,
};
const NONCLIENTMETRICSW = extern struct {
    cbSize: u32 = @sizeOf(NONCLIENTMETRICSW),
    border_width: i32 = 0,
    scroll_width: i32 = 0,
    scroll_height: i32 = 0,
    caption_width: i32 = 0,
    caption_height: i32 = 0,
    caption_font: LOGFONTW = undefined,
    sm_caption_width: i32 = 0,
    sm_caption_height: i32 = 0,
    sm_caption_font: LOGFONTW = undefined,
    menu_width: i32 = 0,
    menu_height: i32 = 0,
    menu_font: LOGFONTW = undefined,
    status_font: LOGFONTW = undefined,
    message_font: LOGFONTW = undefined,
    padded_border_width: i32 = 0,
};
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
extern "user32" fn MessageBoxW(?HWND, [*:0]const u16, [*:0]const u16, u32) callconv(.winapi) i32;
extern "user32" fn IsDialogMessageW(HWND, *MSG) callconv(.winapi) i32;
extern "user32" fn GetWindowTextW(HWND, [*]u16, i32) callconv(.winapi) i32;
extern "user32" fn DestroyWindow(HWND) callconv(.winapi) i32;
extern "user32" fn SendMessageW(HWND, u32, WPARAM, LPARAM) callconv(.winapi) LRESULT;
extern "user32" fn SetFocus(?HWND) callconv(.winapi) ?HWND;
extern "user32" fn LoadCursorW(?HINSTANCE, usize) callconv(.winapi) ?*anyopaque;
extern "user32" fn AdjustWindowRectEx(*RECT, u32, i32, u32) callconv(.winapi) i32;
extern "user32" fn SystemParametersInfoW(u32, u32, ?*anyopaque, u32) callconv(.winapi) i32;
extern "gdi32" fn CreateFontIndirectW(*const LOGFONTW) callconv(.winapi) ?*anyopaque;
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
const ID_CODE = 6;

const WM_CLOSE = 0x0010;
const WM_SETFONT = 0x0030;
const WM_COMMAND = 0x0111;
const EM_LIMITTEXT = 0x00C5;
const IDOK = 1;
const IDCANCEL = 2;
const ID_CODE_EDIT = 100;
const WS_POPUP: u32 = 0x80000000;
const WS_CHILD: u32 = 0x40000000;
const WS_VISIBLE: u32 = 0x10000000;
const WS_CAPTION: u32 = 0x00C00000;
const WS_SYSMENU: u32 = 0x00080000;
const WS_TABSTOP: u32 = 0x00010000;
const WS_EX_DLGMODALFRAME: u32 = 0x1;
const WS_EX_TOPMOST: u32 = 0x8;
const WS_EX_CLIENTEDGE: u32 = 0x200;
const ES_UPPERCASE: u32 = 0x8;
const ES_AUTOHSCROLL: u32 = 0x80;
const BS_DEFPUSHBUTTON: u32 = 0x1;
const SPI_GETNONCLIENTMETRICS = 0x29;
const COLOR_BTNFACE = 15;
const IDC_ARROW = 32512;
const SM_CXSCREEN = 0;
const SM_CYSCREEN = 1;
const MB_ICONERROR = 0x10;
const MB_ICONINFORMATION = 0x40;
const MB_SETFOREGROUND = 0x10000;
const MB_TOPMOST = 0x40000;
const code_class = L("Direct360AgentCode");

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
        .outdated => "Update the Direct360 Helper Agent",
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
    const tip = std.fmt.bufPrint(&tip_buf, "Direct360 Helper Agent · {s}", .{statusLine(&line_buf)}) catch "Direct360 Helper Agent";
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
    add(menu, MF_STRING | MF_GRAYED, 0, "Direct360 Helper Agent " ++ machine.version);
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
    add(menu, MF_STRING, ID_CODE, "Enter connection code…");
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
        ID_CODE => enterCode(),
        ID_OPEN => {
            var web_buf: [300]u8 = undefined;
            var url_buf: [320]u8 = undefined;
            const url = std.fmt.bufPrint(&url_buf, "{s}" ++ connect.settings_path, .{tray.session.webBase(tray.io, &web_buf)}) catch return;
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

/// The "Enter connection code" window while it is open, and what was typed when Connect was pressed.
var code_window: ?HWND = null;
var code_edit: ?HWND = null;
var code_text: [64]u16 = undefined;
var code_len: usize = 0;
var code_font: ?*anyopaque = null;

fn codeProc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) callconv(.winapi) LRESULT {
    switch (msg) {
        WM_COMMAND => {
            const id = wparam & 0xFFFF;
            if (id == IDOK) {
                const n = if (code_edit) |e| GetWindowTextW(e, &code_text, code_text.len) else 0;
                code_len = @intCast(@max(n, 0));
                _ = DestroyWindow(hwnd);
            } else if (id == IDCANCEL) {
                code_len = 0;
                _ = DestroyWindow(hwnd);
            }
            return 0;
        },
        WM_CLOSE => {
            code_len = 0;
            _ = DestroyWindow(hwnd);
            return 0;
        },
        WM_DESTROY => {
            code_window = null;
            code_edit = null;
            return 0;
        },
        else => return DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

fn child(parent: HWND, class: [*:0]const u16, text: [*:0]const u16, style: u32, ex: u32, id: usize, x: i32, y: i32, w: i32, h: i32) ?HWND {
    const c = CreateWindowExW(ex, class, text, WS_CHILD | WS_VISIBLE | style, x, y, w, h, parent, @ptrFromInt(id), GetModuleHandleW(null), null) orelse return null;
    if (code_font) |f| _ = SendMessageW(c, WM_SETFONT, @intFromPtr(f), 1);
    return c;
}

/// A small window asking for the code from Direct360 → Settings → Processing; runs its own message loop until it is
/// closed. The code typed (UTF-16), or null when cancelled or left empty.
fn askCode() ?[]const u16 {
    const inst = GetModuleHandleW(null);
    if (code_font == null) {
        var m: NONCLIENTMETRICSW = .{};
        if (SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, @sizeOf(NONCLIENTMETRICSW), &m, 0) != 0) code_font = CreateFontIndirectW(&m.message_font);
    }
    const style = WS_POPUP | WS_CAPTION | WS_SYSMENU | WS_VISIBLE;
    const ex = WS_EX_DLGMODALFRAME | WS_EX_TOPMOST;
    var r: RECT = .{ .left = 0, .top = 0, .right = 380, .bottom = 136 };
    _ = AdjustWindowRectEx(&r, style, 0, ex);
    const w = r.right - r.left;
    const h = r.bottom - r.top;
    const x = @divTrunc(GetSystemMetrics(SM_CXSCREEN) - w, 2);
    const y = @divTrunc(GetSystemMetrics(SM_CYSCREEN) - h, 2);
    const win = CreateWindowExW(ex, code_class, L("Direct360 Helper Agent"), style, x, y, w, h, null, null, inst, null) orelse return null;
    code_window = win;
    code_len = 0;
    _ = child(win, L("STATIC"), L("Connection code from Direct360 → Settings → Processing:"), 0, 0, 0, 16, 16, 348, 20);
    code_edit = child(win, L("EDIT"), L(""), WS_TABSTOP | ES_UPPERCASE | ES_AUTOHSCROLL, WS_EX_CLIENTEDGE, ID_CODE_EDIT, 16, 44, 348, 26);
    if (code_edit) |e| _ = SendMessageW(e, EM_LIMITTEXT, code_text.len - 1, 0);
    _ = child(win, L("BUTTON"), L("Connect"), WS_TABSTOP | BS_DEFPUSHBUTTON, 0, IDOK, 196, 92, 80, 28);
    _ = child(win, L("BUTTON"), L("Cancel"), WS_TABSTOP, 0, IDCANCEL, 284, 92, 80, 28);
    _ = SetForegroundWindow(win);
    _ = SetFocus(code_edit);

    var msg: MSG = undefined;
    while (code_window != null) {
        const got = GetMessageW(&msg, null, 0, 0);
        if (got <= 0) {
            // Quit was asked while the window was open: close it and pass the quit on to the main loop.
            if (code_window) |cw| _ = DestroyWindow(cw);
            if (got == 0) PostQuitMessage(@intCast(msg.wParam));
            return null;
        }
        // Tab, Enter (Connect) and Esc (Cancel) as in a dialog.
        if (code_window) |cw| if (IsDialogMessageW(cw, &msg) != 0) continue;
        _ = TranslateMessage(&msg);
        _ = DispatchMessageW(&msg);
    }
    const typed = std.mem.trim(u16, code_text[0..code_len], &.{ ' ', '\t' });
    return if (typed.len == 0) null else typed;
}

fn message(flags: u32, text: []const u8) void {
    var buf: [700]u16 = undefined;
    _ = MessageBoxW(null, wide(&buf, text).ptr, L("Direct360 Helper Agent"), flags | MB_SETFOREGROUND | MB_TOPMOST);
}

/// Tray → Enter connection code…: asks for the code and pairs with it on another thread; the result is shown either way.
fn enterCode() void {
    if (code_window) |w| {
        _ = SetForegroundWindow(w);
        return;
    }
    const typed = askCode() orelse return;
    const code = std.unicode.utf16LeToUtf8Alloc(tray.gpa, typed) catch return;
    const t = std.Thread.spawn(.{}, pairWithCode, .{code}) catch |err| {
        tray.gpa.free(code);
        message(MB_ICONERROR, "Connecting could not start.");
        log.say(tray.io, "connecting with a code could not start ({s})", .{@errorName(err)});
        return;
    };
    t.detach();
}

fn pairWithCode(code: []u8) void {
    defer tray.gpa.free(code);
    var arena: std.heap.ArenaAllocator = .init(tray.gpa);
    defer arena.deinit();
    log.say(tray.io, "connecting with a code typed in the tray", .{});
    if (tray.connector.pairCode(arena.allocator(), code)) |why| {
        var buf: [600]u8 = undefined;
        message(MB_ICONERROR, std.fmt.bufPrint(&buf, "Connecting failed: {s}", .{why}) catch "Connecting failed.");
    } else {
        message(MB_ICONINFORMATION, "Connected to Direct360.");
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
    const code_wc: WNDCLASSEXW = .{
        .lpfnWndProc = codeProc,
        .hInstance = inst,
        .lpszClassName = code_class,
        .hIcon = wc.hIcon,
        .hCursor = LoadCursorW(null, IDC_ARROW),
        .hbrBackground = @ptrFromInt(COLOR_BTNFACE + 1),
    };
    if (RegisterClassExW(&code_wc) == 0) return error.TrayClass;
    hwnd_main = CreateWindowExW(0, window_class, L("Direct360 Helper Agent"), 0, 0, 0, 0, 0, null, null, inst, null) orelse return error.TrayWindow;
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
