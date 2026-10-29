# Prices every resource in the subscription as it bills while the host is down. Used by lib.sh's
# audit; tested in test_azure_tools.py. Prices: Azure retail, malaysiawest, INR, 730 hours a month
# (docs/MAINTENANCE.md, "What it costs").
# Input variables: $r (ARM resource list), $d (disks, with size and SKU), $vms (id → power state),
# $sa (storage account id → bytes used), $mtd (resource id → cost so far this month, from Cost
# Management, a day behind), $today and $free_until (YYYY-MM-DD).
# Status: ok (₹0 idle), expected (pennies we keep on purpose: the backups), free (the 12-month
# allowance), BILLING (fails the audit). An unknown type is BILLING until someone prices it.
def lc: ascii_downcase;
def r2: . * 100 | round / 100;
def row($status; $monthly; $note): {status: $status, monthly: $monthly, name, type, note: $note};
def disk_price:
  (.properties.diskSizeGB // 0) as $gb
  | if .sku.name == "Premium_LRS" and $gb <= 64 then 979.76
    elif .sku.name == "StandardSSD_LRS" and $gb <= 32 then 230.37
    elif .sku.name == "StandardSSD_LRS" and $gb <= 64 then 460.75
    else null end;
def idle_free: [
  "microsoft.network/virtualnetworks", "microsoft.network/networksecuritygroups", "microsoft.network/networkinterfaces",
  "microsoft.network/networkwatchers", "microsoft.insights/actiongroups", "microsoft.insights/activitylogalerts",
  "microsoft.insights/metricalerts", "microsoft.managedidentity/userassignedidentities", "microsoft.keyvault/vaults",
  "microsoft.compute/virtualmachines/extensions", "microsoft.compute/virtualmachines/runcommands",
  "microsoft.compute/sshpublickeys"];

($d | map({key: (.id | lc), value: .}) | from_entries) as $disks
| [ $r[] | (.type | lc) as $t
    | if $t == "microsoft.compute/virtualmachines" then
        ($vms[.id | lc] // "PowerState/unknown") as $p
        | if $p == "PowerState/deallocated" then row("ok"; 0; "deallocated: no compute charge")
          else row("BILLING"; 750; "\($p): compute bills by the hour until deallocated (₹1.03/h, B2ats v2)") end
      elif $t == "microsoft.compute/disks" then
        ($disks[.id | lc] // .) as $k
        | ($mtd[.id | lc] // 0) as $billed
        | if $k.sku.name == "Premium_LRS" and ($k.properties.diskSizeGB // 999) <= 64 and $today < $free_until and $billed < 1 then
            row("free"; 0; "P6, free until \($free_until) (Portal → Free services), then ₹979.76/month")
          elif $billed >= 1 and $today < $free_until and $k.sku.name == "Premium_LRS" then
            row("BILLING"; 979.76; "P6, but ₹\($billed | r2) billed this month: the free allowance doesn't cover it")
          else row("BILLING"; ($k | disk_price); "\($k.sku.name // "?") \($k.properties.diskSizeGB // "?") GiB, billed whether or not the VM runs") end
      elif $t == "microsoft.network/publicipaddresses" then
        row("BILLING"; 350; "a static IPv4 bills by the hour, attached or not (₹0.48/h)")
      elif $t == "microsoft.storage/storageaccounts" then
        (($sa[.id | lc] // 0) / 1e9) as $gb
        | row("expected"; ($gb * 1.7278 | r2); "\($gb | r2) GB of backups at ₹1.73/GB (kept on purpose)")
      elif ($t | IN(idle_free[])) then row("ok"; 0; "no charge while idle")
      else row("BILLING"; null; "a type this audit doesn't know: check its price, then add it to audit.jq") end ]
| { rows: map(.monthly |= (if . == null then "₹?" else "₹\(.)" end)),
    billing: map(select(.status == "BILLING")) | length,
    billing_monthly: ([.[] | select(.status == "BILLING") | .monthly // 0] | add // 0 | r2),
    expected: ([.[] | select(.status == "expected") | .monthly] | add // 0 | r2) }
