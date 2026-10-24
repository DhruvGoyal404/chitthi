#!/usr/bin/env bash
# Grows /data's filesystem to fill its disk, after the disk itself was enlarged in Azure
# (docs/MAINTENANCE.md, "Disk growth"). ext4 grows while mounted: nothing stops. Runs as root:
#
#   deploy/azure/run-on-vm.sh deploy/host/grow-data-disk.sh
#
# Idempotent: with nothing to grow, resize2fs says so and the size stays.
set -euo pipefail

die() { echo "grow-data-disk: FAILED: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || die "run as root"
dev=$(findmnt -no SOURCE /data) || die "/data is not mounted"
name=$(basename "$(readlink -f "$dev")")
# bootstrap.sh formats the whole disk, never a partition; a partition would need growing first.
[[ ! -e /sys/class/block/$name/partition ]] || die "$dev is a partition: this script only grows a whole-disk filesystem"
before=$(df -BM --output=size /data | tail -n 1 | tr -d ' ')
# The kernel sees a disk Azure enlarged once its SCSI device is rescanned. (CI's loop device has no
# rescan; its test refreshes the size with losetup -c first.)
if [[ -w /sys/class/block/$name/device/rescan ]]; then echo 1 > "/sys/class/block/$name/device/rescan"; fi
resize2fs "$dev"
after=$(df -BM --output=size /data | tail -n 1 | tr -d ' ')
echo "grow-data-disk: /data was $before, now $after"
df -h /data
