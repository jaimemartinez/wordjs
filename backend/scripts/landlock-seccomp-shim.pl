#!/usr/bin/perl
# WordJS - zero-configuration kernel confinement for an isolated plugin child on Linux.
#
# WHY THIS EXISTS
# ---------------
# macOS confines a plugin with Seatbelt and Windows with an AppContainer: in both cases the process
# restricts ITSELF, unprivileged, with nothing configured on the host. Linux had no such floor. The
# The retired namespace launcher depended on a separately-installed executable and on unprivileged user
# namespaces, which stock hardened distributions may refuse. A sandbox that needs either is not
# zero-configuration. This shim is the Linux implementation now: it applies the equivalent security
# properties directly to itself and execs Node, without a namespace, daemon, package or sysctl.
#
# Two kernel features need NEITHER privileges NOR namespaces, which is precisely the gap:
#   . seccomp-bpf, once the process sets PR_SET_NO_NEW_PRIVS. This is how browsers confine renderers.
#   . Landlock, an LSM designed for unprivileged self-sandboxing (Ubuntu ships it enabled: "landlock" is
#     first in CONFIG_LSM on every architecture, so it needs no boot parameter).
#
# WHY PERL, of all things
# ----------------------
# Both are raw syscalls, and Node cannot make one: there is no node:ffi, internalBinding is not exposed,
# and shipping a compiled helper would put a per-architecture binary inside the very mechanism that
# confines untrusted code. Perl's `syscall()` is a core builtin, and `perl-base` is `Essential: yes` on
# Debian and Ubuntu - it is guaranteed present on any host that has apt. So the vehicle is ~200 lines of
# TEXT, auditable in one sitting, with no build step, no npm dependency and no artefact to trust.
#
# WHY IT CONFINES NODE AND NOT JUST PERL
# --------------------------------------
# A Landlock domain and a seccomp filter are both INHERITED ACROSS execve and by every thread created
# afterwards. Restricting a single-threaded Perl process and then exec'ing Node therefore confines the
# whole Node process - including libuv's threadpool, which is what makes the per-thread nature of
# landlock_restrict_self a non-issue here. It also means the PID the caller spawned IS Node's PID: no
# intermediate process, which lets the resident-memory poll watch the real child PID directly.
#
# CERTIFIED on GitHub runners, control vs confined, same binary and script, unprivileged uid 1001:
#   ubuntu-latest  Ubuntu 24.04.4, kernel 6.17, landlock ABI 7, apparmor_restrict_unprivileged_userns=1
#     control  {"writeInZone":"OK","writeOutside":"OK",    "readSystem":"OK","tcp":"CONNECTED"}
#     confined {"writeInZone":"OK","writeOutside":"EACCES","readSystem":"OK","tcp":"EACCES"}
#     NoNewPrivs: 1   Seccomp: 2
#   ubuntu-22.04   kernel 6.8, landlock ABI 4 - identical result.
#
# A PROPERTY THAT COMES FREE, AND IT IS A BIG ONE. Landlock installs a ptrace hook: a process inside a
# Landlock domain may not PTRACE_MODE_READ a process outside it. Reading /proc/<pid>/environ goes through
# exactly that check, so a confined plugin cannot read the environment of the HOST backend it was forked
# from - which is where JWT_SECRET and the database credentials live. MEASURED (WSL2, kernel 6.6, same
# uid, same user, a `sleep` holding a marker in its environ): unconfined perl reads it and finds the
# marker; the identical perl under this shim gets EACCES. Without a pid namespace that read is otherwise
# wide open to any same-uid process, so this is not a nicety: Landlock closes a concrete secret-
# exfiltration path without needing a PID namespace.
#
# The network denial comes from seccomp. With no grant every socket() and socketpair() is refused; with
# a grant only AF_INET/AF_INET6 client sockets may be created. That covers TCP and UDP and prevents local
# D-Bus/X11/daemon access through AF_UNIX. The already-open IPC descriptor needs neither syscall. On ABI
# >= 4 Landlock's TCP restriction is ALSO applied as an independent denial (see below).
#
# USAGE
#   landlock-seccomp-shim.pl [--read-root=PATH]... <zone>... <denyNetwork:0|1> -- <argv...>
#
# The pre-`--` grammar is "every option first, then one or more writable zones, then the network flag",
# and it is unambiguous because the flag is the LAST pre-`--` token and is required to be exactly 0 or 1.
# The single-zone spelling `shim.pl <zone> <0|1> -- <argv>` that the committed measurement used is
# therefore still valid, byte for byte; multiple zones simply add tokens in front of the flag. The read
# root may also arrive as WORDJS_READ_ROOT in the environment (additive, and the spelling the
# linux-zeroconf-probe workflow uses).
#
# EXIT CODES - THE FAIL-CLOSED CONTRACT. This script NEVER exec's the target unless every confinement
# step it promised actually took effect. A caller must be able to tell "confined" from "ran bare", so
# there is no path that degrades silently into launching the child unconfined:
#   78  SHIM-UNSUPPORTED  this kernel/architecture cannot provide the floor at all (no Landlock, or an
#                         architecture whose syscall numbers are not in the table below). Nothing was
#                         exec'd. The caller should report 'unsupported' - not 'active', and not a
#                         failure of this host to do something it could have done.
#   79  SHIM-FAIL         the floor COULD have applied here and a step failed (a ruleset that would not
#                         create, a zone that would not grant, seccomp refused). Nothing was exec'd.
#   127 SHIM-EXEC-FAIL    the confinement applied and the target could not be exec'd.
# Anything else is the exit code of the confined child itself.

use strict;
use warnings;
use Cwd qw(realpath);

# --- exit codes, as named constants so the caller and this file cannot drift -----------------------
my $EX_UNSUPPORTED = 78;
my $EX_FAIL        = 79;
my $EX_EXEC        = 127;

sub unsupported { print STDERR "SHIM-UNSUPPORTED: $_[0]\n"; exit $EX_UNSUPPORTED; }
sub fail        { print STDERR "SHIM-FAIL: $_[0]\n";        exit $EX_FAIL; }

# --- syscall numbers, per architecture -----------------------------------------------------------
# VERIFIED against real kernel headers on a Linux host, not from memory:
#   x86_64  /usr/include/x86_64-linux-gnu/asm/unistd_64.h -> prctl 157, seccomp 317, socket 41
#   aarch64 /usr/include/asm-generic/unistd.h             -> prctl 167, seccomp 277, socket 198
#     (aarch64 uses the asm-generic table verbatim, which is why that header is the authority for it)
# The three landlock_* numbers are identical on both (they were added in the shared asm-generic table
# and x86_64 mirrors them): landlock_create_ruleset 444, landlock_add_rule 445, landlock_restrict_self
# 446 - also confirmed in /usr/include/asm-generic/unistd.h.
# Anything else refuses to run rather than guessing: a wrong syscall number would not fail loudly, it
# would call SOMETHING ELSE.
my $arch = `uname -m`; chomp $arch;
my ($NR_prctl, $NR_seccomp, $NR_socket, $NR_socketpair, $NR_clone, $NR_clone3, $NR_capset, $NR_setgroups,
    $AUDIT_ARCH, $X32_ABI, @BLOCKED);
if ($arch eq 'x86_64') {
    ($NR_prctl, $NR_seccomp, $NR_socket, $NR_socketpair, $NR_clone, $NR_clone3, $NR_capset, $NR_setgroups,
        $AUDIT_ARCH, $X32_ABI) = (157, 317, 41, 53, 56, 435, 126, 116, 0xc000003e, 1);
    @BLOCKED = (
        # ptrace, kexec, modules, legacy kernel-control entry points, bpf/perf/userfaultfd,
        # cross-process memory, keyrings, mount/swap/reboot/setns/handle APIs.
        101, 246, 320, 175, 313, 176, 174, 177, 178, 321, 298, 323, 310, 311, 312,
        248, 249, 250, 165, 166, 155, 167, 168, 169, 272, 308, 304, 303, 180, 156,
        154, 172, 173, 300, 301,
        # System V IPC. Refusing these calls provides the namespace-free equivalent authority reduction
        # for a web plugin, which has no legitimate SysV IPC use.
        29, 30, 31, 64, 65, 66, 67, 68, 69, 70, 71,
        # Host identity mutation and cross-process signalling. The parent can still signal this child;
        # these calls only remove the child's ability to signal the host or its peers.
        57, 58, 170, 171, 62, 200, 234, 129, 297, 424, 434, 438, 440, 448,
        # Identity/capability changes and device-node creation are setup-only. The shim clears privilege
        # before installing this filter; the child may never reacquire or reshape it.
        105, 106, 113, 114, 116, 117, 119, 122, 123, 126, 133, 259,
        # No inbound server surface, even for a network-granted plugin.
        43, 49, 50, 288,
        # Anonymous executable creation / alternate exec, io_uring and the modern mount API.
        319, 322, 447, 425, 426, 427, 428, 429, 430, 431, 432, 433,
    );
}
elsif ($arch eq 'aarch64') {
    ($NR_prctl, $NR_seccomp, $NR_socket, $NR_socketpair, $NR_clone, $NR_clone3, $NR_capset, $NR_setgroups,
        $AUDIT_ARCH, $X32_ABI) = (167, 277, 198, 199, 220, 435, 91, 159, 0xc00000b7, 0);
    @BLOCKED = (
        117, 104, 294, 105, 273, 106, 280, 241, 282, 270, 271, 272, 217, 218, 219,
        40, 39, 41, 224, 225, 142, 97, 268, 265, 264, 262, 263,
        186, 187, 188, 189, 190, 191, 192, 193, 194, 195, 196, 197,
        161, 162, 129, 130, 131, 138, 240, 424, 434, 438, 440, 448,
        143, 144, 145, 146, 147, 149, 151, 152, 159, 91, 33,
        200, 201, 202, 242,
        279, 281, 447, 425, 426, 427, 428, 429, 430, 431, 432, 433,
    );
}
else { unsupported("architecture $arch has no verified syscall table here"); }
my ($NR_ll_create, $NR_ll_add, $NR_ll_restrict) = (444, 445, 446);

my $O_PATH    = 010000000;
my $O_CLOEXEC = 02000000;
my $PR_SET_NO_NEW_PRIVS = 38;
my $PR_CAPBSET_DROP = 24;
my $PR_SET_SECUREBITS = 28;
my $PR_CAP_AMBIENT = 47;
my $PR_CAP_AMBIENT_CLEAR_ALL = 4;

# Landlock filesystem access rights (uapi/linux/landlock.h).
my $FS_EXECUTE    = 1 << 0;
my $FS_WRITE_FILE = 1 << 1;
my $FS_READ_FILE  = 1 << 2;
my $FS_READ_DIR   = 1 << 3;
my $FS_REMOVE_DIR = 1 << 4;
my $FS_REMOVE_FILE = 1 << 5;
my $FS_MAKE_DIR   = 1 << 7;
my $FS_MAKE_REG   = 1 << 8;
my $FS_REFER      = 1 << 13;
my $FS_TRUNCATE   = 1 << 14;
my $FS_IOCTL_DEV  = 1 << 15;
# Landlock network access rights, ABI 4+.
my $NET_BIND_TCP    = 1 << 0;
my $NET_CONNECT_TCP = 1 << 1;

# --- argument parsing ----------------------------------------------------------------------------
my (@pre, @cmd);
my $saw_sep = 0;
for my $a (@ARGV) {
    if (!$saw_sep && $a eq '--') { $saw_sep = 1; next; }
    if ($saw_sep) { push @cmd, $a } else { push @pre, $a }
}
fail("expected `--` before the command") unless $saw_sep;
fail("no command given after `--`")      unless @cmd;

my (@read_roots, @exec_roots);
while (@pre && $pre[0] =~ /^--(read|exec)-root=(.*)$/s) {
    my ($kind, $value) = ($1, $2); shift @pre;
    $kind eq 'read' ? push(@read_roots, $value) : push(@exec_roots, $value);
}
push @read_roots, $ENV{WORDJS_READ_ROOT} if defined $ENV{WORDJS_READ_ROOT} && length $ENV{WORDJS_READ_ROOT};

my $denyNet = @pre ? pop @pre : '';
fail("the last argument before `--` must be the network flag, 0 or 1 (got '$denyNet')")
    unless $denyNet eq '0' || $denyNet eq '1';
my @zones = @pre;
fail("at least one writable zone is required") unless @zones;
for my $z (@zones, @read_roots, @exec_roots) {
    # Landlock matches a path it can OPEN; a relative path would resolve against whatever cwd this
    # process happens to have, which is not something a confinement boundary may depend on. And a zone
    # of `/` would make the whole filesystem writable, turning a typo into a total loss of confinement.
    fail("paths must be absolute (got '$z')") unless substr($z, 0, 1) eq '/';
    fail("`/` is never a valid zone or read root")     if $z eq '/';
}

# Resolve before opening rules. O_PATH follows symlinks, so validating only the lexical spelling would
# let a zone such as /safe/link -> / grant the target outside the declared boundary.
for my $set (\@zones, \@read_roots, \@exec_roots) {
    my %seen;
    my @resolved;
    for my $p (@$set) {
        my $real = realpath($p);
        fail("cannot resolve sandbox path $p") unless defined $real && length $real;
        fail("a sandbox path resolved to / ($p)") if $real eq '/';
        push @resolved, $real unless $seen{$real}++;
    }
    @$set = @resolved;
}

# --- Landlock: confine the filesystem ------------------------------------------------------------
#
# THE READ GRANTS ARE A DELIBERATE LIST, AND THE LIST IS THE POINT.
# The obvious alternative is one read-only rule on `/`.
# This does LESS than that, on purpose: the trees below are "the operating system", and the ones that
# are conspicuously absent - /home, /root, /srv, /media, /mnt, /tmp, /var/tmp, /var/www, /var/backups -
# are "the operator's data". A plugin under this shim cannot read the operator's home directory, their
# ssh keys, or an unrelated site's document root; a blanket read-only root would still expose all of
# those paths for READING.
# Narrowing further - enumerating only the paths Node happens to touch - was considered and rejected:
# the set differs by distro (NixOS puts the whole runtime under /nix, Alpine under /usr/lib, a
# self-compiled Node under /opt or /usr/local) and by Node version, so one missing entry is a child that
# never reaches JavaScript, and that failure looks like "Landlock is broken here" rather than "one path
# is missing". A path in the list that does not exist on this host is simply SKIPPED, so the list can
# afford to be generous about layouts while staying strict about user data.
# The application itself does not appear here at all: it arrives as --read-root / WORDJS_READ_ROOT,
# which the CALLER must set, and a read root that will not grant is FATAL rather than skipped (an app
# root the child cannot read is a child that cannot load its worker).
my @READ_TREES = qw(
    /usr/lib /usr/lib64 /lib /lib64 /lib32 /libx32
    /usr/share/zoneinfo /usr/share/locale /usr/share/icu
    /etc/ssl /etc/ca-certificates /etc/localtime /etc/hosts /etc/nsswitch.conf /etc/resolv.conf /etc/gai.conf
    /proc/self /proc/thread-self /sys/devices/system/cpu /nix/store
);
my @EXEC_FILES = qw(
    /lib64/ld-linux-x86-64.so.2 /lib/x86_64-linux-gnu/ld-linux-x86-64.so.2
    /lib/ld-linux-aarch64.so.1 /lib/aarch64-linux-gnu/ld-linux-aarch64.so.1
);

my $abi = syscall($NR_ll_create, 0, 0, 1);   # LANDLOCK_CREATE_RULESET_VERSION
# FAIL CLOSED. This is the branch the committed version got wrong: it left `$landlock = 'off'` and went
# on to exec the child anyway, so a kernel without Landlock produced a completely unconfined process
# that exited 0 and looked exactly like a confined one. Demonstrated, not theorised - with the landlock
# syscall numbers bent to a nonexistent number the old script printed `landlock=off seccomp=off`, ran
# the target, wrote a file OUTSIDE its zone and exited 0.
unsupported("landlock_create_ruleset is unavailable on this kernel ($!)") if !defined($abi) || $abi < 1;

# handled_access_fs grew with each ABI; ask for exactly what this kernel knows, or create_ruleset
# rejects the whole request with E2BIG.
#   ABI 1 (5.13): bits 0-12  = 0x1fff   EXECUTE..MAKE_SYM
#   ABI 2 (5.19): + REFER    = 0x3fff
#   ABI 3 (6.2):  + TRUNCATE = 0x7fff
#   ABI 4 (6.7):  no new FS bits - it adds handled_access_net (see below)
#   ABI 5 (6.10): + IOCTL_DEV (bit 15). Handled now: only /dev/null receives it; writable zones do not.
#   ABI 6 (6.12): + `scoped` (abstract UNIX sockets, signals). Both scopes are requested below: the
#                 inherited IPC socketpair remains usable, while new host D-Bus/X11-style abstract-socket
#                 connections and signals aimed outside the Landlock domain are refused.
#   ABI 7 (6.15): audit-logging flags for landlock_restrict_self. Nothing to gain here.
my $HANDLED = $abi >= 5 ? 0xffff : ($abi >= 3 ? 0x7fff : ($abi >= 2 ? 0x3fff : 0x1fff));

# ABI 4 net restriction: a SECOND, INDEPENDENT denial beside seccomp, from a different subsystem, on a
# different hook. seccomp still carries the load because Landlock's network hook is SOCK_STREAM only -
# it does not see UDP, and therefore does not see DNS - while the seccomp filter refuses socket() by
# address family and so covers TCP and UDP alike. Two independent mechanisms denying the same thing is
# the whole reason to pay for the second one: a bug in either still leaves a denial standing.
my $handle_net = ($denyNet eq '1' && $abi >= 4) ? 1 : 0;
# ABI 6 can scope abstract AF_UNIX sockets and signals to this Landlock domain. The inherited IPC
# socketpair remains usable because it is already connected; new connections to a host D-Bus/X11-style
# abstract socket and signals aimed at the backend do not. On older ABIs seccomp still refuses the
# signal syscalls, while filesystem-named Unix sockets remain bounded by the filesystem rules.
my $scoped = $abi >= 6 ? 3 : 0; # LANDLOCK_SCOPE_ABSTRACT_UNIX_SOCKET | LANDLOCK_SCOPE_SIGNAL
my $attr = $abi >= 6
    ? pack("QQQ", $HANDLED, ($handle_net ? $NET_BIND_TCP | $NET_CONNECT_TCP : 0), $scoped)
    : ($handle_net ? pack("QQ", $HANDLED, $NET_BIND_TCP | $NET_CONNECT_TCP) : pack("Q", $HANDLED));
my $rfd  = syscall($NR_ll_create, $attr, ($abi >= 6 ? 24 : ($handle_net ? 16 : 8)), 0);
fail("landlock_create_ruleset: $!") if !defined($rfd) || $rfd < 0;

my $RO = $FS_READ_FILE | $FS_READ_DIR;
my $RX_FILE = $FS_READ_FILE | $FS_EXECUTE;

my $granted = 0;
my $grant = sub {
    my ($path, $acc) = @_;
    return 0 unless defined $path && length $path;
    sysopen(my $fh, $path, $O_PATH | $O_CLOEXEC) or return 0;
    # struct landlock_path_beneath_attr { __u64 allowed_access; __s32 parent_fd; } __attribute__((packed))
    # -> 12 bytes, and Perl's pack inserts no alignment padding, so "Ql" is exactly right.
    my $pb = pack("Ql", $acc, fileno($fh));
    my $r  = syscall($NR_ll_add, $rfd, 1, $pb, 0);   # LANDLOCK_RULE_PATH_BENEATH
    close $fh;
    $granted++ if defined($r) && $r == 0;
    return defined($r) && $r == 0;
};

$grant->($_, $RO) for @READ_TREES;      # missing on this host => skipped, see the note above
$grant->($_, $RX_FILE) for @EXEC_FILES; # ELF PT_INTERP; without EXECUTE the kernel refuses the initial image

# Literal boot devices only. Granting the /dev tree let a privileged caller reach raw disks, packet
# devices and future device nodes. Writable zones never receive MAKE_CHAR/MAKE_BLOCK or IOCTL_DEV.
for my $d (qw(/dev/urandom /dev/random /dev/zero)) { $grant->($d, $FS_READ_FILE); }
$grant->('/dev/null', $FS_READ_FILE | $FS_WRITE_FILE | ($abi >= 5 ? $FS_IOCTL_DEV : 0));

# A read root the caller ASKED for is fatal when it will not grant. The OS list above is best-effort
# because its entries are guesses about a distro layout; this one is not a guess, it is the application.
for my $r (@read_roots) {
    # A caller may need one configuration FILE (the source-only ts-node worker needs exactly
    # backend/tsconfig.json) without granting the directory that contains it. Landlock accepts a
    # regular file as the parent_fd of PATH_BENEATH, but READ_DIR is not a valid right for that inode.
    # Select the smallest compatible access set after realpath() has fixed the object we are granting.
    my $read_access = -d $r ? $RO : $FS_READ_FILE;
    $grant->($r, $read_access) or fail("cannot grant the read root $r");
}
for my $r (@exec_roots) {
    $grant->($r, $RX_FILE) or fail("cannot grant the executable root $r");
}

# THE WRITABLE ZONES - io-guard's write zones, passed in by the caller. EXECUTE is deliberately removed
# from the granted set: these are the only directories the plugin can write, so granting execute there
# too would let it drop a binary and run it - the W^X hole the macOS profile refuses for the same reason.
# Everything else in the access set stays, so the zone is fully usable as storage.
my $ZONE_ACC = $FS_READ_FILE | $FS_READ_DIR | $FS_WRITE_FILE | $FS_REMOVE_DIR | $FS_REMOVE_FILE
    | $FS_MAKE_DIR | $FS_MAKE_REG
    | ($abi >= 2 ? $FS_REFER : 0)
    | ($abi >= 3 ? $FS_TRUNCATE : 0);
for my $z (@zones) {
    $grant->($z, $ZONE_ACC) or fail("cannot grant the writable zone $z");
}

# A service launched as root must not hand that identity/capability set to an untrusted plugin. Keep the
# UID (root-owned application trees must remain usable) but remove root semantics, supplementary groups,
# every capability set and the bounding set. Locked securebits and no_new_privs make the reduction
# irreversible across the exec into Node.
my $status = '';
if (open(my $sf, '<', '/proc/self/status')) { local $/; $status = <$sf>; close $sf; }
my ($cap_eff) = $status =~ /^CapEff:\s*([0-9a-fA-F]+)/m;
my ($cap_prm) = $status =~ /^CapPrm:\s*([0-9a-fA-F]+)/m;
my $privileged = ($> == 0 || hex($cap_eff || '0') != 0 || hex($cap_prm || '0') != 0);
if ($privileged) {
    syscall($NR_setgroups, 0, 0) == 0 or fail("setgroups(clear): $!");
    # SECBIT_NOROOT|LOCKED + SECBIT_NO_SETUID_FIXUP|LOCKED.
    syscall($NR_prctl, $PR_SET_SECUREBITS, 15, 0, 0, 0) == 0 or fail("prctl(SECUREBITS): $!");
    for my $cap (0 .. 63) {
        my $r = syscall($NR_prctl, $PR_CAPBSET_DROP, $cap, 0, 0, 0);
        last if $r != 0 && $!{EINVAL};
        fail("prctl(CAPBSET_DROP $cap): $!") if $r != 0;
    }
    syscall($NR_prctl, $PR_CAP_AMBIENT, $PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0) == 0
        or fail("prctl(AMBIENT_CLEAR_ALL): $!");
    my $cap_header = pack('Ll', 0x20080522, 0); # _LINUX_CAPABILITY_VERSION_3, current pid
    my $cap_data = pack('LLLLLL', 0, 0, 0, 0, 0, 0);
    syscall($NR_capset, $cap_header, $cap_data) == 0 or fail("capset(clear): $!");
    my $after = '';
    if (open(my $af, '<', '/proc/self/status')) { local $/; $after = <$af>; close $af; }
    for my $name (qw(CapInh CapPrm CapEff CapBnd CapAmb)) {
        my ($v) = $after =~ /^$name:\s*([0-9a-fA-F]+)/m;
        fail("$name survived privilege drop") if !defined($v) || hex($v) != 0;
    }
}

# no_new_privs is a PRECONDITION for both landlock_restrict_self and seccomp for an unprivileged caller.
syscall($NR_prctl, $PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0 or fail("prctl(NO_NEW_PRIVS): $!");
syscall($NR_ll_restrict, $rfd, 0) == 0 or fail("landlock_restrict_self: $!");

# --- seccomp: reduce the kernel attack surface and expose only client IP sockets when granted -------
# This filter is ALWAYS installed. The dangerous-syscall denylist is independent of the plugin's
# network grant. The inherited IPC descriptor needs no socket() call: no-network denies every new socket;
# a network grant permits only AF_INET/AF_INET6 client sockets. socketpair and inbound bind/listen/accept
# remain denied in both shapes.
#
# args[0] is a __u64 and this reads its LOW 32 bits, which is the correct half and not an accident: the
# kernel's socket() takes `int family`, so a caller passing 0x1_0000_0002 is truncated to AF_INET by the
# kernel and matched as AF_INET here. Reading the high half instead would be the bypass.
my @p = (
    [0x20, 0, 0, 4],                    # A = seccomp_data.arch
    [0x15, 1, 0, $AUDIT_ARCH],          # matching arch skips the KILL
    [0x06, 0, 0, 0],                    # wrong arch: KILL_THREAD
    [0x20, 0, 0, 0],                    # A = seccomp_data.nr
);
my @deny_jumps;

# Node/V8 needs pthreads after exec, so clone cannot be denied wholesale. Permit only CLONE_THREAD
# (the kernel also requires CLONE_VM|CLONE_SIGHAND for that flag); every process-shaped clone jumps to
# EPERM. clone3 puts its flags behind a pointer that classic BPF cannot inspect, so return ENOSYS and let
# glibc fall back to clone(), where the flags are inspectable. This closes fork bombs without breaking
# libuv/V8 worker threads.
push @p, [0x15, 0, 4, $NR_clone];        # non-clone skips the flag block and reloads nr
push @p, [0x20, 0, 0, 16];              # args[0], low 32 bits: clone flags
push @p, [0x54, 0, 0, 0x00010000];      # A &= CLONE_THREAD
push @p, [0x15, 1, 0, 0x00010000];      # thread clone skips the denial jump
push @deny_jumps, scalar(@p);
push @p, [0x05, 0, 0, 0];               # process clone -> EPERM (patched below)
push @p, [0x20, 0, 0, 0];               # restore A = seccomp_data.nr

my @enosys_jumps;
push @enosys_jumps, scalar(@p);
push @p, [0x15, 0, 0, $NR_clone3];       # force the inspectable clone() fallback
if ($X32_ABI) {
    push @deny_jumps, scalar(@p);
    push @p, [0x35, 0, 0, 0x40000000];  # deny the complete x32 ABI range
}
for my $nr (sort { $a <=> $b } @BLOCKED) {
    push @deny_jumps, scalar(@p);
    push @p, [0x15, 0, 0, $nr];
}

my (@network_jumps, @allow_jumps);
if ($denyNet eq '1') {
    push @network_jumps, scalar(@p); push @p, [0x15, 0, 0, $NR_socket];
    push @network_jumps, scalar(@p); push @p, [0x15, 0, 0, $NR_socketpair];
} else {
    # Non-socket syscalls skip the family block. AF_INET/AF_INET6 jump to ALLOW; every other family
    # reaches the unconditional jump to the network-denial return.
    push @p, [0x15, 0, 4, $NR_socket];
    push @p, [0x20, 0, 0, 16];          # args[0], low 32 bits: socket address family
    push @allow_jumps, scalar(@p); push @p, [0x15, 0, 0, 2];    # AF_INET
    push @allow_jumps, scalar(@p); push @p, [0x15, 0, 0, 10];   # AF_INET6
    push @network_jumps, scalar(@p); push @p, [0x05, 0, 0, 0];  # all other families -> EACCES
    push @network_jumps, scalar(@p); push @p, [0x15, 0, 0, $NR_socketpair];
}
push @p, [0x06, 0, 0, 0x7fff0000];      # ALLOW
my $allow_idx = scalar(@p) - 1;
my $deny_idx = scalar(@p);
push @p, [0x06, 0, 0, 0x00050001];      # ERRNO(EPERM) for dangerous syscalls
my $network_idx = scalar(@p);
push @p, [0x06, 0, 0, 0x0005000d];       # ERRNO(EACCES) for forbidden socket creation
my $enosys_idx = scalar(@p);
push @p, [0x06, 0, 0, 0x00050026];       # ERRNO(ENOSYS) for clone3

for my $i (@deny_jumps) {
    if ($p[$i]->[0] == 0x05) { $p[$i]->[3] = $deny_idx - ($i + 1); }
    else { $p[$i]->[1] = $deny_idx - ($i + 1); }
}
for my $i (@network_jumps) {
    if ($p[$i]->[0] == 0x05) { $p[$i]->[3] = $network_idx - ($i + 1); }
    else { $p[$i]->[1] = $network_idx - ($i + 1); }
}
for my $i (@allow_jumps) {
    $p[$i]->[1] = $allow_idx - ($i + 1);
}
for my $i (@enosys_jumps) {
    $p[$i]->[1] = $enosys_idx - ($i + 1);
}

my $I = sub { pack("SCCL", @_) };       # struct sock_filter
my $filter = join("", map { $I->(@$_) } @p);
# struct sock_fprog { unsigned short len; struct sock_filter *filter; } - 2 bytes, 6 of padding on
# LP64, then the pointer.
my $prog = pack("Sx6J", scalar(@p), unpack("J", pack("P", $filter)));
# SECCOMP_SET_MODE_FILTER(1) with TSYNC(1): every existing thread gets the filter too.
syscall($NR_seccomp, 1, 1, $prog) == 0 or fail("seccomp(SET_MODE_FILTER): $!");

# One line, on stderr, with a stable prefix the caller can grep and the log limiter can rate-limit.
print STDERR "SHIM: landlock=abi$abi/$granted landlock-net=" . ($handle_net ? 'on' : 'off')
    . " scoped=" . ($scoped ? 'unix+signal' : 'legacy')
    . " seccomp=on/" . scalar(@BLOCKED) . " network=" . ($denyNet eq '1' ? 'deny' : 'allow')
    . " arch=$arch zones=" . scalar(@zones) . "\n";

# The block form pins argv[0] as the FILE to execute. `exec @cmd` with a single-element list is checked
# by Perl for shell metacharacters and handed to /bin/sh when it finds any - which would insert a shell
# into a confinement boundary on exactly the inputs an attacker would choose.
# `no warnings 'exec'` silences the compile-time "statement unlikely to be reached" note: the lines after
# exec are the FAILURE path and they are exactly what makes this fail-closed, so they must stay.
{
    no warnings 'exec';
    exec { $cmd[0] } @cmd;
}
print STDERR "SHIM-FAIL: exec $cmd[0]: $!\n";
exit $EX_EXEC;
