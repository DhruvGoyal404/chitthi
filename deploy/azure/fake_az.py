"""A stand-in for the Azure CLI, for testing deploy/azure/setup.sh without an Azure account
(deploy/azure/test_azure_tools.py, SetupInfra). It keeps resources in a JSON state file
(FAKE_AZ_STATE) and answers only the commands setup.sh uses, the way az does:

- `create` refuses a resource that already exists, as Azure did with an existing activity log
  alert during go-live. setup.sh must check and update instead, so a second run proves it does.
- `--query` is evaluated with jmespath, the library az itself uses, so setup.sh's real queries run.
- The last `--output` wins, as in az (that exact behaviour once fed jq TSV).
- Numbers Azure returns as floats (budget thresholds, lifecycle days) come back as floats.
Every call is appended to FAKE_AZ_STATE + ".log", one JSON array of arguments per line.
"""

import json
import os
import sys

import jmespath

SUB = "00000000-0000-0000-0000-00000000c0de"
TENANT = "11111111-1111-1111-1111-111111111111"
ME = "22222222-2222-2222-2222-222222222222"
IMAGES = {"Canonical:ubuntu-24_04-lts:server:24.04.202610210", "Canonical:ubuntu-24_04-lts:server:24.04.202610220"}
ALLOWED = ["eastasia", "koreacentral", "uaenorth", "indonesiacentral", "malaysiawest"]


class NotFound(Exception):
    pass


class Conflict(Exception):
    pass


def parse(argv):
    """Leading words are the command; then flags, each with the values that follow it."""
    words, i = [], 0
    while i < len(argv) and not argv[i].startswith("-"):
        words.append(argv[i])
        i += 1
    flags, name = {}, None
    for tok in argv[i:]:
        if tok.startswith("-") and len(tok) > 1 and (tok[1] == "-" or tok[1].isalpha()):
            name = tok.lstrip("-")
            flags.setdefault(name, [])
        elif name is not None:
            flags[name].append(tok)
    return tuple(words), flags


def one(flags, *names, default=None):
    for n in names:
        if flags.get(n):
            v = flags[n][-1]
            if v.startswith("@"):
                with open(v[1:], encoding="utf-8") as f:
                    return f.read()
            return v
    return default


def floats(x, keys):
    """Turn the named integer fields into floats, recursively, as Azure returns them."""
    if isinstance(x, dict):
        return {k: (float(v) if k in keys and isinstance(v, int) else floats(v, keys)) for k, v in x.items()}
    if isinstance(x, list):
        return [floats(v, keys) for v in x]
    return x


class Az:
    def __init__(self, state):
        self.s = state
        self.r = state.setdefault("res", {})
        state.setdefault("assignments", [{"principalId": ME, "roleDefinitionName": "Owner", "scope": f"/subscriptions/{SUB}"}])

    # resource helpers
    def get(self, kind, key):
        try:
            return self.r[kind][key]
        except KeyError:
            raise NotFound(f"{kind} {key}")

    def create(self, kind, key, obj):
        if key in self.r.setdefault(kind, {}):
            raise Conflict(f"{kind} {key} already exists")
        self.r[kind][key] = obj
        return obj

    def put(self, kind, key, obj):
        self.r.setdefault(kind, {})[key] = obj
        return obj

    def run(self, words, f):
        g, n = one(f, "g", "resource-group"), one(f, "n", "name")
        rg = f"/subscriptions/{SUB}/resourceGroups"
        w = words
        if w == ("account", "show"):
            return {"id": SUB, "tenantId": TENANT, "name": "Azure for Students"}
        if w == ("account", "set"):
            return None
        if w == ("ad", "signed-in-user", "show"):
            return {"id": ME}
        if w == ("policy", "assignment", "list"):
            return [{"displayName": "Allowed locations", "parameters": {"listOfAllowedLocations": {"value": ALLOWED}}},
                    {"displayName": "Something else", "parameters": {"effect": {"value": "Audit"}}}]
        if w == ("vm", "list-skus"):
            return [{"name": "Standard_B2ats_v2", "restrictions": [], "capabilities": [{"name": "PremiumIO", "value": "True"}]}]
        if w == ("provider", "show"):
            return {"registrationState": "Registered"}
        if w == ("group", "show"):
            return self.get("group", one(f, "name", "n"))
        if w == ("group", "create"):
            return self.put("group", one(f, "name", "n"), {"location": one(f, "location", "l")})
        if w == ("resource", "list"):
            return []
        if w == ("vm", "image", "show"):
            if one(f, "urn") not in IMAGES:
                raise NotFound("image")
            return {}
        # network
        if w == ("network", "vnet", "show"):
            return self.get("vnet", n)
        if w == ("network", "vnet", "create"):
            return self.create("vnet", n, {"name": n})
        if w == ("network", "nsg", "show"):
            return self.get("nsg", n)
        if w == ("network", "nsg", "create"):
            return self.create("nsg", n, {"name": n})
        if w[:3] == ("network", "nsg", "rule"):
            key = f"{one(f, 'nsg-name')}/{n}"
            rule = lambda: {"name": n, "priority": int(one(f, "priority")), "direction": one(f, "direction"), "access": one(f, "access"),
                            "protocol": one(f, "protocol"), "sourceAddressPrefix": one(f, "source-address-prefixes"),
                            "destinationPortRange": one(f, "destination-port-ranges")}
            if w[3] == "show":
                return self.get("rule", key)
            if w[3] == "create":
                return self.create("rule", key, rule())
            if w[3] == "update":
                self.get("rule", key)
                return self.put("rule", key, rule())
            if w[3] == "list":
                return [v for k, v in self.r.get("rule", {}).items() if k.startswith(one(f, "nsg-name") + "/")]
        if w == ("network", "public-ip", "show"):
            return self.get("pip", n)
        if w == ("network", "public-ip", "create"):
            return self.create("pip", n, {"ipAddress": "203.0.113.7", "publicIPAllocationMethod": one(f, "allocation-method"),
                                          "sku": {"name": one(f, "sku")}})
        if w == ("network", "nic", "list"):
            return list(self.r.get("nic", {}).values())
        # disks, locks, VM
        if w == ("disk", "show"):
            return self.get("disk", n)
        if w == ("disk", "create"):
            return self.create("disk", n, {"name": n, "sku": one(f, "sku")})
        if w[0] == "lock":
            key = f"{g}/{one(f, 'resource')}/{one(f, 'resource-type')}/{n}"
            if w[1] == "show":
                return self.get("lock", key)
            if w[1] == "create":
                return self.create("lock", key, {"level": one(f, "lock-type"), "notes": one(f, "notes")})
            if w[1] == "update":
                self.get("lock", key)
                return self.put("lock", key, {"level": one(f, "lock-type"), "notes": one(f, "notes")})
            if w[1] == "list":
                prefix = f"{g}/{one(f, 'resource')}/{one(f, 'resource-type')}/"
                return [v for k, v in self.r.get("lock", {}).items() if k.startswith(prefix)]
        if w == ("vm", "show"):
            return self.get("vm", n)
        if w == ("vm", "create"):
            vm_id = f"{rg}/{g}/providers/Microsoft.Compute/virtualMachines/{n}"
            self.put("nic", n, {"virtualMachine": {"id": vm_id},
                                "networkSecurityGroup": {"id": f"{rg}/{g}/providers/Microsoft.Network/networkSecurityGroups/{one(f, 'nsg')}"}})
            return self.create("vm", n, {"hardwareProfile": {"vmSize": one(f, "size")},
                                         "identity": {"type": "SystemAssigned", "principalId": "vm-principal-0001"},
                                         "securityProfile": {"securityType": one(f, "security-type")},
                                         "storageProfile": {"dataDisks": [], "imageReference": {"exactVersion": one(f, "image").split(":")[-1]}}})
        if w == ("vm", "disk", "attach"):
            vm = self.get("vm", one(f, "vm-name"))
            vm["storageProfile"]["dataDisks"].append({"lun": int(one(f, "lun")), "name": n})
            return vm
        if w == ("vm", "boot-diagnostics", "enable"):
            self.get("vm", n)
            return None
        if w == ("vm", "get-instance-view"):
            self.get("vm", n)
            return {"instanceView": {"statuses": [{"code": "ProvisioningState/succeeded"}, {"code": "PowerState/running"}]}}
        # storage
        if w[:2] == ("storage", "account") and w[2] in ("show", "create", "update"):
            if w[2] == "show":
                return self.get("sa", n)
            obj = {"allowSharedKeyAccess": one(f, "allow-shared-key-access") == "true",
                   "allowBlobPublicAccess": one(f, "allow-blob-public-access") == "true",
                   "minimumTlsVersion": one(f, "min-tls-version"), "enableHttpsTrafficOnly": one(f, "https-only") == "true",
                   "accessTier": one(f, "access-tier")}
            if w[2] == "create":
                return self.create("sa", n, obj)
            self.get("sa", n)
            return self.put("sa", n, obj)
        if w == ("storage", "account", "blob-service-properties", "update"):
            return self.put("blobsvc", one(f, "account-name"), {
                "deleteRetentionPolicy": {"enabled": one(f, "enable-delete-retention") == "true", "days": int(one(f, "delete-retention-days"))},
                "isVersioningEnabled": one(f, "enable-versioning") == "true"})
        if w == ("storage", "account", "blob-service-properties", "show"):
            return self.get("blobsvc", one(f, "account-name"))
        if w == ("storage", "container-rm", "show"):
            return self.get("container", n)
        if w == ("storage", "container-rm", "create"):
            return self.create("container", n, {"publicAccess": "None"})
        if w == ("storage", "account", "management-policy", "create"):  # a PUT in Azure: create or replace
            return self.put("mgmt", one(f, "account-name"), {"policy": floats(json.loads(one(f, "policy")), {"daysAfterCreationGreaterThan"})})
        if w == ("storage", "account", "management-policy", "show"):
            return self.get("mgmt", one(f, "account-name"))
        # Key Vault
        if w == ("keyvault", "show"):
            return self.get("kv", n)
        if w == ("keyvault", "create"):
            return self.create("kv", n, {"properties": {"enableRbacAuthorization": True, "enablePurgeProtection": True, "enableSoftDelete": True}})
        if w == ("keyvault", "secret", "list"):
            return []
        # roles
        if w[:2] == ("role", "definition"):
            if w[2] == "list":
                return [d for d in self.r.get("roledef", {}).values() if d["roleName"] == one(f, "name")]
            d = json.loads(one(f, "role-definition"))
            obj = {"roleName": d["Name"], "permissions": [{"actions": d["Actions"], "notActions": [], "dataActions": d["DataActions"], "notDataActions": []}]}
            if w[2] == "create":
                return self.create("roledef", d["Name"], obj)
            self.get("roledef", d["Name"])
            return self.put("roledef", d["Name"], obj)
        if w == ("role", "assignment", "list"):
            out = self.s["assignments"]
            if one(f, "assignee"):
                out = [a for a in out if a["principalId"] == one(f, "assignee")]
            scope = one(f, "scope")
            if scope and "all" not in f:
                inherited = "include-inherited" in f
                out = [a for a in out if a["scope"].lower() == scope.lower() or (inherited and scope.lower().startswith(a["scope"].lower()))]
            return out
        if w == ("role", "assignment", "create"):
            a = {"principalId": one(f, "assignee-object-id"), "roleDefinitionName": one(f, "role"), "scope": one(f, "scope")}
            if a in self.s["assignments"]:
                raise Conflict("RoleAssignmentExists")
            self.s["assignments"].append(a)
            return a
        # identities
        if w == ("identity", "show"):
            return self.get("identity", n)
        if w == ("identity", "create"):
            return self.create("identity", n, {"principalId": "deploy-principal-0001", "clientId": "deploy-client-0001"})
        if w[:2] == ("identity", "federated-credential"):
            key = f"{one(f, 'identity-name')}/{n}"
            if w[2] == "show":
                return self.get("fic", key)
            if w[2] == "list":
                return [v for k, v in self.r.get("fic", {}).items() if k.startswith(one(f, "identity-name") + "/")]
            obj = {"issuer": one(f, "issuer"), "subject": one(f, "subject"), "audiences": f.get("audiences", [])}
            if w[2] == "create":
                return self.create("fic", key, obj)
            self.get("fic", key)
            return self.put("fic", key, obj)
        # monitoring
        if w[:2] == ("monitor", "action-group"):
            if w[2] == "show":
                return self.get("ag", n)
            if w[2] == "create":
                a = f["action"]
                return self.create("ag", n, {"emailReceivers": [{"name": a[1], "emailAddress": a[2]}]})
            if w[2] == "update":
                ag = self.get("ag", n)
                gone = set(f.get("remove-action", []))
                ag["emailReceivers"] = [r for r in ag["emailReceivers"] if r["name"] not in gone]
                if f.get("add-action"):
                    a = f["add-action"]
                    ag["emailReceivers"].append({"name": a[1], "emailAddress": a[2]})
                return ag
        if w[:3] == ("monitor", "metrics", "alert") or w[:3] == ("monitor", "activity-log", "alert"):
            kind = w[1]
            if w[3] == "show":
                return self.get(kind, n)
            if w[3] == "create":
                return self.create(kind, n, {"enabled": True, "condition": one(f, "condition"), "description": one(f, "description")})
            if w[3] == "update":
                obj = self.get(kind, n)
                for k in ("condition", "description"):
                    if one(f, k):
                        obj[k] = one(f, k)
                obj["enabled"] = one(f, "enabled", default="true") == "true"
                return obj
        if w == ("rest",):
            method, url = one(f, "method"), one(f, "url")
            if "CostManagement/query" in url:
                return {"properties": {"rows": [[0.0, "INR"]]}}
            if "/versions?" in url:
                return [{"name": i.split(":")[-1]} for i in sorted(IMAGES)]
            if "/budgets/" in url:
                if method == "get":
                    return self.get("budget", "b")
                body = json.loads(one(f, "body"))
                body = floats(body, {"threshold", "amount"})
                body["eTag"] = '"1"'
                return self.put("budget", "b", body)
        raise SystemExit(f"fake az: unsupported command: {' '.join(words)}")


def tsv(value):
    def scalar(x):
        return "" if x is None else str(x)

    def row(x):
        if isinstance(x, dict):
            return "\t".join(scalar(v) for v in x.values())
        if isinstance(x, list):
            return "\t".join(scalar(v) for v in x)
        return scalar(x)

    if value is None:
        return ""
    if isinstance(value, list):
        return "\n".join(row(x) for x in value)
    return row(value)


def main():
    sys.stdout.reconfigure(newline="\n")  # az prints LF; so must this, even on Windows
    path = os.environ["FAKE_AZ_STATE"]
    with open(path + ".log", "a", encoding="utf-8") as log:
        log.write(json.dumps(sys.argv[1:]) + "\n")
    state = json.load(open(path, encoding="utf-8")) if os.path.exists(path) else {}
    words, flags = parse(sys.argv[1:])
    try:
        result = Az(state).run(words, flags)
    except NotFound as e:
        print(f"ERROR: (ResourceNotFound) {e} was not found.", file=sys.stderr)
        sys.exit(3)
    except Conflict as e:
        print(f"ERROR: (Conflict) {e}.", file=sys.stderr)
        sys.exit(1)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(state, fh)
    if flags.get("query"):
        result = jmespath.search(flags["query"][-1], result)
    output = (flags.get("output") or flags.get("o") or ["json"])[-1]
    if output == "json":
        print(json.dumps(result, indent=2))
    elif output == "tsv":
        text = tsv(result)
        if text:
            print(text)


if __name__ == "__main__":
    main()
