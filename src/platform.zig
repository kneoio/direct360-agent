//! What differs between systems outside the tray: opening a link or file with the system's default program, a
//! console for command-line use of the windowless Windows program, one copy at a time, and child processes that end
//! with the agent.
const std = @import("std");
const builtin = @import("builtin");
const Io = std.Io;
const windows = std.os.windows;
const linux = std.os.linux;
const jobs_run = @import("job.zig");
const is_windows = builtin.os.tag == .windows;
const is_linux = builtin.os.tag == .linux;

extern "shell32" fn ShellExecuteW(hwnd: ?windows.HWND, op: ?[*:0]const u16, file: [*:0]const u16, params: ?[*:0]const u16, dir: ?[*:0]const u16, show: i32) callconv(.winapi) isize;
extern "kernel32" fn AttachConsole(pid: u32) callconv(.winapi) i32;
extern "kernel32" fn SetStdHandle(which: u32, handle: windows.HANDLE) callconv(.winapi) i32;
extern "kernel32" fn GetStdHandle(which: u32) callconv(.winapi) ?windows.HANDLE;
extern "kernel32" fn CreateFileW(name: [*:0]const u16, access: u32, share: u32, sa: ?*anyopaque, disposition: u32, flags: u32, template: ?windows.HANDLE) callconv(.winapi) windows.HANDLE;
extern "kernel32" fn CreateMutexW(sa: ?*anyopaque, owner: i32, name: [*:0]const u16) callconv(.winapi) ?windows.HANDLE;
extern "kernel32" fn GetLastError() callconv(.winapi) u32;
extern "kernel32" fn CreateJobObjectW(sa: ?*anyopaque, name: ?[*:0]const u16) callconv(.winapi) ?windows.HANDLE;
extern "kernel32" fn SetInformationJobObject(job: windows.HANDLE, class: i32, info: *const anyopaque, len: u32) callconv(.winapi) i32;
extern "kernel32" fn AssignProcessToJobObject(job: windows.HANDLE, process: windows.HANDLE) callconv(.winapi) i32;
extern "kernel32" fn GetCurrentProcess() callconv(.winapi) windows.HANDLE;

const L = std.unicode.utf8ToUtf16LeStringLiteral;

/// Opens a link or a file the way a double-click would. Logs nothing; returns whether it started.
pub fn open(gpa: std.mem.Allocator, io: Io, target: []const u8) bool {
    if (is_windows) {
        const wide = std.unicode.utf8ToUtf16LeAllocZ(gpa, target) catch return false;
        defer gpa.free(wide);
        return ShellExecuteW(null, L("open"), wide.ptr, null, null, 1) > 32;
    }
    const cmd: []const u8 = if (builtin.os.tag == .macos) "open" else "xdg-open";
    var child = std.process.spawn(io, .{ .argv = &.{ cmd, target }, .stdin = .ignore, .stdout = .ignore, .stderr = .ignore }) catch return false;
    _ = child.wait(io) catch {};
    return true;
}

/// The Windows program has no console of its own (it lives in the tray). Run from a terminal, its command-line
/// output goes to that terminal, unless the output is already redirected (a pipe or a file).
pub fn attachParentConsole() void {
    if (!is_windows) return;
    const STD_OUTPUT_HANDLE: u32 = @bitCast(@as(i32, -11));
    const STD_ERROR_HANDLE: u32 = @bitCast(@as(i32, -12));
    if (GetStdHandle(STD_ERROR_HANDLE)) |h| if (@intFromPtr(h) != 0 and @intFromPtr(h) != std.math.maxInt(usize)) return;
    const ATTACH_PARENT_PROCESS: u32 = 0xFFFFFFFF;
    if (AttachConsole(ATTACH_PARENT_PROCESS) == 0) return;
    const GENERIC_READ_WRITE: u32 = 0x80000000 | 0x40000000;
    const FILE_SHARE_WRITE: u32 = 0x2;
    const OPEN_EXISTING: u32 = 3;
    const con = CreateFileW(L("CONOUT$"), GENERIC_READ_WRITE, FILE_SHARE_WRITE, null, OPEN_EXISTING, 0, null);
    if (@intFromPtr(con) == std.math.maxInt(usize)) return;
    _ = SetStdHandle(STD_OUTPUT_HANDLE, con);
    _ = SetStdHandle(STD_ERROR_HANDLE, con);
}

/// Linux: the socket the first copy listens on (`@direct360-agent-<uid>`, abstract); a second copy connects to it.
pub var instance_socket: ?i32 = null;

fn instanceAddress() linux.sockaddr.un {
    var addr: linux.sockaddr.un = .{ .path = @splat(0) };
    _ = std.fmt.bufPrint(addr.path[1..], "direct360-agent-{d}", .{linux.getuid()}) catch {};
    return addr;
}

fn instanceAddressLen(addr: *const linux.sockaddr.un) linux.socklen_t {
    const name_len = std.mem.indexOfScalar(u8, addr.path[1..], 0) orelse (addr.path.len - 1);
    return @intCast(@offsetOf(linux.sockaddr.un, "path") + 1 + name_len);
}

/// False when another copy of the agent already runs (Windows and Linux; elsewhere always true).
pub fn firstInstance() bool {
    if (is_linux) {
        const rc = linux.socket(linux.AF.UNIX, linux.SOCK.STREAM | linux.SOCK.CLOEXEC, 0);
        if (linux.errno(rc) != .SUCCESS) return true;
        const fd: i32 = @intCast(rc);
        const addr = instanceAddress();
        if (linux.errno(linux.bind(fd, @ptrCast(&addr), instanceAddressLen(&addr))) != .SUCCESS) {
            _ = linux.close(fd);
            return false;
        }
        _ = linux.listen(fd, 4);
        instance_socket = fd;
        return true;
    }
    if (!is_windows) return true;
    _ = CreateMutexW(null, 1, L("Local\\Direct360Agent")) orelse return true;
    const ERROR_ALREADY_EXISTS = 183;
    return GetLastError() != ERROR_ALREADY_EXISTS;
}

/// Linux: tells the copy that already runs that another one was started (it shows the connect page if not connected).
pub fn pokeRunningCopy() void {
    if (!is_linux) return;
    const rc = linux.socket(linux.AF.UNIX, linux.SOCK.STREAM | linux.SOCK.CLOEXEC, 0);
    if (linux.errno(rc) != .SUCCESS) return;
    const fd: i32 = @intCast(rc);
    defer _ = linux.close(fd);
    const addr = instanceAddress();
    _ = linux.connect(fd, @ptrCast(&addr), instanceAddressLen(&addr));
}

/// Linux: a poke from a second copy is waiting on `instance_socket`; takes it and returns.
pub fn takePoke() void {
    const fd = instance_socket orelse return;
    const rc = linux.accept4(fd, null, null, linux.SOCK.CLOEXEC);
    if (linux.errno(rc) == .SUCCESS) _ = linux.close(@intCast(rc));
}

const IoCounters = extern struct { r: u64, w: u64, o: u64, rb: u64, wb: u64, ob: u64 };
const BasicLimits = extern struct {
    per_process_user_time: i64,
    per_job_user_time: i64,
    limit_flags: u32,
    min_working_set: usize,
    max_working_set: usize,
    active_process_limit: u32,
    affinity: usize,
    priority_class: u32,
    scheduling_class: u32,
};
const ExtendedLimits = extern struct {
    basic: BasicLimits,
    io: IoCounters,
    process_memory_limit: usize,
    job_memory_limit: usize,
    peak_process_memory: usize,
    peak_job_memory: usize,
};

fn endJobsAndExit(_: std.posix.SIG) callconv(.c) void {
    jobs_run.stopAll();
    std.c._exit(0);
}

/// Every process the agent starts (render.js, ffmpeg) ends when the agent ends, even when it is closed from the tray
/// in the middle of a render. Windows: a job object. Linux: each job runs in its own process group, which is stopped
/// when the agent is told to end (Quit, Ctrl+C, logging out).
pub fn endChildrenWithAgent() void {
    if (is_linux) {
        const act: std.posix.Sigaction = .{ .handler = .{ .handler = endJobsAndExit }, .mask = std.posix.sigemptyset(), .flags = 0 };
        for ([_]std.posix.SIG{ .TERM, .INT, .HUP }) |sig| std.posix.sigaction(sig, &act, null);
        return;
    }
    if (!is_windows) return;
    const job = CreateJobObjectW(null, null) orelse return;
    var limits = std.mem.zeroes(ExtendedLimits);
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x2000;
    limits.basic.limit_flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    const JobObjectExtendedLimitInformation = 9;
    if (SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, @sizeOf(ExtendedLimits)) == 0) return;
    _ = AssignProcessToJobObject(job, GetCurrentProcess());
}
