#!/usr/bin/perl
# WordJS — zero-configuration kernel confinement for an isolated plugin child on Linux.
#
# WHY THIS EXISTS
# ---------------
# macOS confines a plugin with Seatbelt and Windows with an AppContainer: in both cases the process
# restricts ITSELF, unprivileged, with nothing configured on the host. Linux had no such floor. The
# existing bwrap layer is strictly better where it works — namespaces, uid drop, a read-only root — but
# bwrap ALWAYS creates a user namespace, and Ubuntu 24.04 restricts unprivileged user namespaces by
# default (kernel.apparmor_restrict_unprivileged_userns=1). On a stock Ubuntu host, and on GitHub's
# ubuntu runners, that means the entire Linux kernel floor is simply absent unless the operator runs a
# sysctl. Asking an operator to reconfigure their kernel is not parity; it is a layer most installs will
# never have.
#
# Two kernel features need NEITHER privileges NOR namespaces, which is precisely the gap:
#   · seccomp-bpf, once the process sets PR_SET_NO_NEW_PRIVS. This is how browsers confine renderers.
#   · Landlock, an LSM designed for unprivileged self-sandboxing (Ubuntu ships it enabled: "landlock" is
#     first in CONFIG_LSM on every architecture, so it needs no boot parameter).
#
# WHY PERL, of all things
# ----------------------
# Both are raw syscalls, and Node cannot make one: there is no node:ffi, internalBinding is not exposed,
# and shipping a compiled helper would put a per-architecture binary inside the very mechanism that
# confines untrusted code. Perl's `syscall()` is a core builtin, and `perl-base` is `Essential: yes` on
# Debian and Ubuntu — it is guaranteed present on any host that has apt. So the vehicle is ~100 lines of
# TEXT, auditable in one sitting, with no build step, no npm dependency and no artefact to trust.
#
# WHY IT CONFINES NODE AND NOT JUST PERL
# --------------------------------------
# A Landlock domain and a seccomp filter are both INHERITED ACROSS execve and by every thread created
# afterwards. Restricting a single-threaded Perl process and then exec'ing Node therefore confines the
# whole Node process — including libuv's threadpool, which is what makes the per-thread nature of
# landlock_restrict_self a non-issue here. It also means the PID the caller spawned IS Node's PID: no
# intermediate process, which is better than bwrap for the resident-memory poll that watches the child.
#
# WHAT IT DENIES, MEASURED (WSL2, kernel 6.6, uid 1000, no sudo, no sysctl):
#   control   {"writeInZone":"OK","writeOutside":"OK",    "tcp":"CONNECTED"}
#   confined  {"writeInZone":"OK","writeOutside":"EACCES","tcp":"EACCES"}   NoNewPrivs:1  Seccomp:2
#
# The network denial comes from seccomp refusing socket(AF_INET|AF_INET6), which covers TCP *and* UDP —
# strictly more than Landlock's own network support (ABI 4), whose hook is SOCK_STREAM only and so lets
# DNS through. AF_UNIX is deliberately still allowed: the fork-style IPC channel to the host runs on it.
#
# Usage:  landlock-seccomp-shim.pl <writable-zone> <deny-network:0|1> -- <argv...>
# Exits non-zero WITHOUT exec'ing if any confinement step fails: a caller must be able to tell "confined"
# from "ran unconfined", so this never degrades silently into launching the child bare.

use strict;
use warnings;

# --- syscall numbers, per architecture -----------------------------------------------------------
# The three landlock_* numbers are identical on x86_64 and arm64 (they were added in the shared
# asm-generic table); prctl and seccomp are not. Anything else refuses to run rather than guessing: a
# wrong syscall number would not fail loudly, it would call SOMETHING ELSE.
my $arch = `uname -m`; chomp $arch;
my ($NR_prctl, $NR_seccomp);
if    ($arch eq 'x86_64')  { ($NR_prctl, $NR_seccomp) = (157, 317); }
elsif ($arch eq 'aarch64') { ($NR_prctl, $NR_seccomp) = (167, 277); }
else { print STDERR "SHIM-UNSUPPORTED-ARCH $arch\n"; exit 78; }
my ($NR_ll_create, $NR_ll_add, $NR_ll_restrict) = (444, 445, 446);

my $O_PATH    = 010000000;
my $O_CLOEXEC = 02000000;
my $PR_SET_NO_NEW_PRIVS = 38;

my $zone       = shift @ARGV // die "usage: shim <zone> <denyNet> -- <argv>\n";
my $denyNet    = shift @ARGV // 0;
my $sep        = shift @ARGV // '';
die "expected -- before the command\n" unless $sep eq '--';
die "no command given\n" unless @ARGV;

# --- Landlock: confine the filesystem ------------------------------------------------------------
# Reads stay broad on purpose (the analogue of bwrap's --ro-bind / /): the property being bought here is
# that WRITES cannot leave the plugin's own zone. Narrowing reads would break Node before it started.
my $abi = syscall($NR_ll_create, 0, 0, 1);
my $landlock = 'off';
if ($abi >= 1) {
    # handled_access_fs grew with each ABI; ask for exactly what this kernel knows, or create_ruleset
    # rejects the whole request with E2BIG.
    my $HANDLED = $abi >= 3 ? 0x7fff : ($abi >= 2 ? 0x3fff : 0x1fff);
    my $attr = pack("Q", $HANDLED);
    my $rfd  = syscall($NR_ll_create, $attr, 8, 0);
    if ($rfd >= 0) {
        my $RO = (1 << 0) | (1 << 2) | (1 << 3);   # EXECUTE | READ_FILE | READ_DIR
        my $granted = 0;
        my $grant = sub {
            my ($path, $acc) = @_;
            sysopen(my $fh, $path, $O_PATH | $O_CLOEXEC) or return 0;
            my $pb = pack("Ql", $acc, fileno($fh));
            my $r  = syscall($NR_ll_add, $rfd, 1, $pb, 0);
            close $fh;
            $granted++ if $r == 0;
            return $r == 0;
        };
        $grant->($_, $RO) for qw(/usr /lib /lib64 /bin /sbin /etc /proc /dev /sys /opt /var/lib);
        # The Node runtime and the app itself, wherever they were installed.
        $grant->($ENV{WORDJS_READ_ROOT}, $RO) if $ENV{WORDJS_READ_ROOT};
        $grant->($zone, $HANDLED) or die "SHIM-FAIL: cannot grant the writable zone $zone\n";
        syscall($NR_prctl, $PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0 or die "SHIM-FAIL: no_new_privs: $!\n";
        syscall($NR_ll_restrict, $rfd, 0) == 0 or die "SHIM-FAIL: restrict_self: $!\n";
        $landlock = "abi$abi/$granted";
    }
}

# --- seccomp: deny the network ------------------------------------------------------------------
# A classic-BPF program over struct seccomp_data. Deliberately narrow: it gates socket() by ADDRESS
# FAMILY rather than denying syscalls wholesale, so a plugin keeps AF_UNIX (its IPC channel to the host)
# while losing every IP socket. A wrong-architecture caller is KILLED rather than allowed, which is the
# same discipline the bwrap filter in core/plugin-isolate.ts already applies.
my $seccomp = 'off';
if ($denyNet) {
    syscall($NR_prctl, $PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) == 0 or die "SHIM-FAIL: no_new_privs: $!\n";
    my $AUDIT_ARCH = $arch eq 'x86_64' ? 0xc000003e : 0xc00000b7;   # X86_64 : AARCH64
    my $NR_socket  = $arch eq 'x86_64' ? 41 : 198;
    my $I = sub { pack("SCCL", @_) };                                # struct sock_filter
    my @p = (
        $I->(0x20, 0, 0, 4),            # A = arch
        $I->(0x15, 0, 7, $AUDIT_ARCH),  # if A != this arch -> KILL
        $I->(0x20, 0, 0, 0),            # A = nr
        $I->(0x15, 0, 3, $NR_socket),   # if A != socket -> ALLOW
        $I->(0x20, 0, 0, 16),           # A = args[0]  (address family)
        $I->(0x15, 2, 0, 2),            # AF_INET  -> EACCES
        $I->(0x15, 1, 0, 10),           # AF_INET6 -> EACCES
        $I->(0x06, 0, 0, 0x7fff0000),   # RET ALLOW
        $I->(0x06, 0, 0, 0x0005000d),   # RET ERRNO(EACCES)
        $I->(0x06, 0, 0, 0),            # RET KILL_THREAD (wrong arch)
    );
    my $filter = join("", @p);
    my $prog   = pack("Sx6J", scalar(@p), unpack("J", pack("P", $filter)));
    # SECCOMP_SET_MODE_FILTER(1) with TSYNC(1): every existing thread gets the filter too.
    syscall($NR_seccomp, 1, 1, $prog) == 0 or die "SHIM-FAIL: seccomp: $!\n";
    $seccomp = 'on';
}

print STDERR "SHIM: landlock=$landlock seccomp=$seccomp arch=$arch\n";
exec @ARGV or die "SHIM-FAIL: exec: $!\n";
