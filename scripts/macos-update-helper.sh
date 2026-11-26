#!/bin/sh
# 本应用自带的安装助手，只处理主进程准备的同卷事务目录，绝不读取网络清单或执行包内脚本。
set -eu
umask 077
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
unset ELECTRON_RUN_AS_NODE ELECTRON_RENDERER_URL NODE_OPTIONS DYLD_INSERT_LIBRARIES
target=$1
transaction=$2
parent_pid=$3
token=$4
parent_timeout=$5
launch_timeout=$6
case "$target" in /*.app) ;; *) exit 10 ;; esac
case "$token" in ''|*[!0-9a-f-]*) exit 10 ;; esac
[ "${#token}" -eq 36 ] || exit 10
parent_dir=$(/usr/bin/dirname "$target")
[ "$transaction" = "$parent_dir/.teahouse-update-$token" ] || exit 10
[ -d "$transaction" ] && [ ! -L "$transaction" ] || exit 10
[ -d "$target" ] && [ ! -L "$target" ] || exit 10
[ -d "$transaction/next.app" ] && [ ! -L "$transaction/next.app" ] || exit 10
[ ! -e "$transaction/previous.app" ] || exit 10
case "$parent_pid:$parent_timeout:$launch_timeout" in *[!0-9:]*|::*|:*) exit 10 ;; esac
[ "$parent_pid" -gt 1 ] && [ "$parent_timeout" -ge 1 ] && [ "$parent_timeout" -le 120 ] || exit 10
[ "$launch_timeout" -ge 1 ] && [ "$launch_timeout" -le 120 ] || exit 10

# 状态仅写入本次私有事务目录，便于重启后提示或人工恢复。
status() { printf '%s\n' "$1" > "$transaction/status"; }
status waiting
remaining=$parent_timeout
while kill -0 "$parent_pid" 2>/dev/null; do
  [ "$remaining" -gt 0 ] || { status parent-running; exit 11; }
  sleep 1
  remaining=$((remaining - 1))
done
[ -w "$parent_dir" ] || { status permission-denied; exit 12; }
/usr/bin/codesign --verify --deep --strict "$transaction/next.app" || { status invalid-signature; exit 13; }

# 两次同卷重命名保留旧包；替换失败时立即恢复。
/bin/mv "$target" "$transaction/previous.app" || { status backup-failed; exit 14; }
if ! /bin/mv "$transaction/next.app" "$target"; then
  /bin/mv "$transaction/previous.app" "$target" || { status recovery-required; exit 15; }
  status replace-failed
  exit 16
fi
status starting
"$target/Contents/MacOS/Teahouse" --cabinet-update-token "$token" >> "$transaction/launch.log" 2>&1 &
child_pid=$!
remaining=$launch_timeout
while kill -0 "$child_pid" 2>/dev/null; do
  if [ -f "$transaction/ready" ] && [ ! -L "$transaction/ready" ] && [ "$(cat "$transaction/ready")" = "$token" ]; then
    status completed
    exit 0
  fi
  [ "$remaining" -gt 0 ] || break
  sleep 1
  remaining=$((remaining - 1))
done

# 只终止本助手直接启动的新进程；确认结束后恢复旧包，旧包只重启一次。
kill -TERM "$child_pid" 2>/dev/null || true
remaining=10
while kill -0 "$child_pid" 2>/dev/null; do
  [ "$remaining" -gt 0 ] || { status recovery-required; exit 17; }
  sleep 1
  remaining=$((remaining - 1))
done
wait "$child_pid" 2>/dev/null || true
/bin/mv "$target" "$transaction/failed.app" || { status recovery-required; exit 18; }
/bin/mv "$transaction/previous.app" "$target" || { status recovery-required; exit 19; }
status rolled-back
"$target/Contents/MacOS/Teahouse" >> "$transaction/launch.log" 2>&1 &
exit 20
