#!/bin/sh
# Loads egress.nft in a network namespace and checks bytes, not just connect.
# A listener that sends HELLO is the pass/fail signal: a dropped destination
# returns zero bytes, an allowed one returns HELLO.
set -eu

if [ "$(id -u)" -ne 0 ]; then
  exec sudo -n "$0" "$@"
fi

root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
rules="$root/bin/egress.nft"
ns=puppi-egress-$$

cleanup() {
  ip netns del "$ns" 2>/dev/null || true
}
trap cleanup EXIT

if ! id node >/dev/null 2>&1; then
  useradd --system --no-create-home --shell /usr/sbin/nologin node
fi

marker=$(mktemp)
rm -f "$marker"
if unshare -m sh -c '
  set -eu
  mount -t tmpfs -o ro tmpfs /etc
  export PUPPI_EGRESS_FILTER=1
  "$1" sh -c "echo ran > \"$2\""
' sh "$root/bin/worker-entrypoint" "$marker" 2>/dev/null; then
  echo "entrypoint should fail closed before the command" >&2
  exit 1
fi
if [ -e "$marker" ]; then
  echo "entrypoint ran the command after a filter failure" >&2
  exit 1
fi

ip netns add "$ns"
ip netns exec "$ns" ip link set lo up
ip netns exec "$ns" ip addr add 10.1.0.1/32 dev lo
ip netns exec "$ns" ip addr add 172.16.0.1/32 dev lo
ip netns exec "$ns" ip addr add 192.168.1.1/32 dev lo
ip netns exec "$ns" ip addr add 100.64.0.1/32 dev lo
ip netns exec "$ns" ip addr add 169.254.169.254/32 dev lo
ip netns exec "$ns" ip addr add 1.2.3.4/32 dev lo
ip netns exec "$ns" ip addr add 1.1.1.1/32 dev lo
ip netns exec "$ns" ip addr add 8.8.8.8/32 dev lo
ip netns exec "$ns" ip -6 addr add fd00::3/128 dev lo
ip netns exec "$ns" ip addr add 0.1.0.1/32 dev lo
ip netns exec "$ns" ip -6 addr add fe80::1/64 dev lo
resolv=$(mktemp)
ip netns exec "$ns" unshare -m sh -c '
  set -eu
  work=$(mktemp -d)
  cp -a /etc/passwd /etc/group /etc/nsswitch.conf "$work/" 2>/dev/null || cp -a /etc/passwd /etc/group "$work/"
  mkdir -p "$work/puppi"
  chmod 755 "$work" "$work/puppi"
  cp "$2" "$work/puppi/egress.nft"
  : > "$1"
  touch "$work/resolv.conf"
  mount --bind "$work" /etc
  mount --bind "$1" /etc/resolv.conf
  mount --bind "$2" /etc/puppi/egress.nft
  export PUPPI_EGRESS_FILTER=1
  exec "$3" id -un
' sh "$resolv" "$rules" "$root/bin/worker-entrypoint" >"$marker"
if [ "$(cat "$marker")" != "node" ]; then
  echo "entrypoint did not drop to node" >&2
  cat "$marker" >&2
  exit 1
fi
grep -q '^nameserver 1.1.1.1$' "$resolv"
grep -q '^nameserver 2606:4700:4700::1111$' "$resolv"
mode=$(stat -c %a "$resolv")
owner=$(stat -c %U "$resolv")
if [ "$mode" != "444" ] || [ "$owner" != "root" ]; then
  echo "resolv.conf mode=$mode owner=$owner" >&2
  exit 1
fi

ip netns exec "$ns" python3 - "$@" <<'PY'
import socket, sys, threading, time

HELLO = b"HELLO"
TIMEOUT = 0.4

def serve_tcp(host, port):
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind((host, port))
    sock.listen(8)
    sock.settimeout(5)
    def loop():
        while True:
            try:
                conn, _ = sock.accept()
            except socket.timeout:
                return
            conn.sendall(HELLO)
            conn.close()
    threading.Thread(target=loop, daemon=True).start()
    return sock

def bind_addr(host, port):
    if host.startswith("fe80"):
        return (host, port, 0, socket.if_nametoindex("lo"))
    return (host, port)

def serve_udp(host, port):
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_DGRAM)
    sock.bind(bind_addr(host, port))
    def loop():
        while True:
            try:
                data, addr = sock.recvfrom(512)
            except OSError:
                return
            if data:
                sock.sendto(HELLO, addr)
    threading.Thread(target=loop, daemon=True).start()
    return sock

def read_tcp(host, port):
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.settimeout(TIMEOUT)
    data = b""
    try:
        sock.connect((host, port))
        sock.sendall(b"GET / HTTP/1.0\r\n\r\n")
        while True:
            chunk = sock.recv(4096)
            if not chunk:
                break
            data += chunk
    except (OSError, socket.timeout):
        pass
    finally:
        sock.close()
    return data

def read_udp(host, port):
    family = socket.AF_INET6 if ":" in host else socket.AF_INET
    sock = socket.socket(family, socket.SOCK_DGRAM)
    sock.settimeout(TIMEOUT)
    data = b""
    try:
        sock.sendto(b"\x00\x01", bind_addr(host, port))
        while True:
            chunk, _ = sock.recvfrom(4096)
            data += chunk
    except (OSError, socket.timeout):
        pass
    finally:
        sock.close()
    return data

servers = []
for host, port in [
    ("0.1.0.1", 9),
    ("10.1.0.1", 9),
    ("172.16.0.1", 9),
    ("192.168.1.1", 9),
    ("100.64.0.1", 9),
    ("169.254.169.254", 80),
    ("1.2.3.4", 5432),
    ("127.0.0.1", 9),
    ("::1", 9),
]:
    servers.append(serve_tcp(host, port))

servers.append(serve_udp("1.1.1.1", 53))
servers.append(serve_udp("8.8.8.8", 53))
servers.append(serve_udp("fd00::3", 53))
servers.append(serve_udp("fe80::1", 53))
time.sleep(0.05)

checks = [
    ("0.1.0.1", read_tcp("0.1.0.1", 9), b""),
    ("10.1.0.1", read_tcp("10.1.0.1", 9), b""),
    ("172.16.0.1", read_tcp("172.16.0.1", 9), b""),
    ("192.168.1.1", read_tcp("192.168.1.1", 9), b""),
    ("100.64.0.1", read_tcp("100.64.0.1", 9), b""),
    ("169.254.169.254", read_tcp("169.254.169.254", 80), b""),
    ("127.0.0.1", read_tcp("127.0.0.1", 9), b""),
    ("::1", read_tcp("::1", 9), b""),
    ("fd00::3", read_udp("fd00::3", 53), b""),
    ("fe80::1", read_udp("fe80::1", 53), b""),
    ("8.8.8.8", read_udp("8.8.8.8", 53), b""),
    ("1.2.3.4", read_tcp("1.2.3.4", 5432), HELLO),
    ("1.1.1.1", read_udp("1.1.1.1", 53), HELLO),
]

failed = False
for name, got, want in checks:
    ok = got == want
    print(f"{'ok' if ok else 'FAIL'} {name} bytes={len(got)} want={len(want)}")
    if not ok:
        failed = True

for sock in servers:
    sock.close()

sys.exit(1 if failed else 0)
PY
