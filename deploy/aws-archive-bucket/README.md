# AWS archive bucket for archive push

Creates an S3 bucket and per-pod keys for **Settings → Backup → S3** (see
[ADR 0026](../../docs/adr/0026-s3-archive-push.md)). It exists so nobody has to
hand-write the IAM policy: the hand-written version usually ends up able to
read or delete everything, or skips versioning.

Other providers (Cloudflare R2, Backblaze B2, MinIO on a NAS) work with the same
setting. Their manual steps are in the ADR's
[provider table](../../docs/adr/0026-s3-archive-push.md#least-privilege-contract).

## What it creates

- **Bucket**
  - Public access blocked, ACLs disabled, SSE-S3 encryption on, plain HTTP refused.
  - Versioning on, plus a governance-mode Object Lock (30 days by default).
  - `force_destroy = false`: `terraform destroy` fails while the bucket holds data.
- **Lifecycle**
  - `<pod>/raw/` moves to Glacier Instant Retrieval after 30 days and is kept forever.
  - `<pod>/db/` snapshots expire after 90 days.
  - `<pod>/probe/` (written by the Test button) expires after 1 day.
  - Overwritten versions expire after 30 days, and incomplete uploads after 1 day.
- **One IAM user and access key per pod.** The key can list and create objects
  under its own `<pod>/` prefix and nothing else:
  - It can't read, delete or overwrite anything.
  - It can't see other pods' prefixes.
  - It can optionally be limited to your home IP.
- **A read-only IAM user** for restores and for pulling the archive to a laptop.
- **Optional:** a monthly S3 budget email.

## Use

```sh
cd deploy/aws-archive-bucket
cp terraform.tfvars.example terraform.tfvars   # edit bucket_name and pods
terraform init
terraform apply

terraform output pod_settings                   # endpoint, region, bucket, prefix, key ID
terraform output -json pod_secret_access_keys   # the secret for each pod
```

Enter each pod's values on that pod under **Settings → Backup → S3**, paste the
secret, then press **Test**. Test lists the prefix and writes one object under
`probe/`. It does not change anything else.

## The state file holds the secrets

`aws_iam_access_key` stores each secret in `terraform.tfstate`. Every Terraform
setup that creates keys works this way.

- Keep the state local, as configured. The `.gitignore` here covers the
  state, plans and `terraform.tfvars`.
- If you move the state to a remote backend, use an encrypted one that only
  you can read.
- If you'd rather keep secrets out of state, set `create_access_keys = false`.
  Then create the keys yourself in the IAM console for the
  `sleepypod-archive-<pod>` users that Terraform made.

**Rotate a pod key:**
`terraform apply -replace='aws_iam_access_key.pod["bedroom"]'`, then paste the
new secret into that pod's settings.

## Decide before the first apply

- **`object_lock_days`** (default 30). Turning Object Lock on later forces the
  bucket to be replaced, which `force_destroy = false` blocks while it holds
  data. Set it to `0` if you want no lock at all.
  - The lock is governance mode, so the account owner can still remove locked
    versions with `s3:BypassGovernanceRetention`. Pod keys can't.
- **`region`.** Pick the one nearest your pods. Moving later means copying the
  data to a new bucket.

## Knobs

| Variable | Default | Effect |
|---|---|---|
| `pods` | — | One prefix, IAM user and key per name |
| `raw_transition_days` / `raw_transition_storage_class` | `30` / `GLACIER_IR` | When RAW goes cold, and to which class. `0` keeps it in STANDARD |
| `raw_expire_days` | `0` (never) | Delete RAW after this many days |
| `db_expire_days` | `90` | Delete database snapshots after this many days |
| `noncurrent_version_days` | `30` | How long an overwritten or deleted version survives |
| `enforce_create_only` | `true` | Pod uploads must send `If-None-Match: *` |
| `allowed_source_cidrs` | `[]` | Only accept pod keys from these public IPs |
| `create_reader` | `true` | Read-only user for restores |
| `budget_email` / `budget_usd` | off / `5` | Monthly S3 spend alert |

## Cost

A pod writes about 250 MB of gzipped RAW a day (about 90 GB a year), plus one
`biometrics.db` snapshot a night. With the defaults, storage stays well under
$1/month after the first year. AWS's first 100 GB/month of transfer out to the
internet is free, so pulling the archive back for training normally costs only
the Glacier IR retrieval fee (about $0.03/GB). Check the S3 pricing page for
your region.

## Teardown

Empty the bucket in the console first: any locked versions have to age out or
be bypassed. Then run `terraform destroy`. Keys and users are removed with it.
