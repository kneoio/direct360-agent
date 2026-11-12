const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const root = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
        // macOS CPU load comes from libSystem (host_statistics); the Linux tray loads GTK and AppIndicator with dlopen.
        .link_libc = target.result.os.tag == .macos or target.result.os.tag == .linux,
    });

    if (target.result.os.tag == .windows) root.addWin32ResourceFile(.{ .file = b.path("assets/resources.rc") });
    // The Linux tray icons (white, and faint for the pulse while a job runs).
    root.addAnonymousImport("tray_white_png", .{ .root_source_file = b.path("assets/tray-white.png") });
    root.addAnonymousImport("tray_white_dim_png", .{ .root_source_file = b.path("assets/tray-white-dim.png") });

    const exe = b.addExecutable(.{ .name = "direct360-agent", .root_module = root });
    // The Windows program lives in the tray: no console window of its own.
    if (target.result.os.tag == .windows) exe.subsystem = .windows;
    b.installArtifact(exe);

    const run = b.addRunArtifact(exe);
    run.step.dependOn(b.getInstallStep());
    run.addPassthruArgs();
    b.step("run", "Run the agent").dependOn(&run.step);

    const tests = b.addTest(.{ .root_module = root });
    b.step("test", "Run the unit tests").dependOn(&b.addRunArtifact(tests).step);
}
