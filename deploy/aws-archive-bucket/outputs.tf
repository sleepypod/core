output "bucket" {
  description = "Archive bucket name."
  value       = aws_s3_bucket.archive.bucket
}

output "region" {
  description = "Archive bucket region."
  value       = var.region
}

output "endpoint" {
  description = "S3 endpoint to enter in Settings → Backup."
  value       = "https://s3.${var.region}.amazonaws.com"
}

output "pod_settings" {
  description = "Per-pod values for Settings → Backup → S3. The secret is in pod_secret_access_keys."
  value = {
    for p in var.pods : p => {
      endpoint      = "https://s3.${var.region}.amazonaws.com"
      region        = var.region
      bucket        = aws_s3_bucket.archive.bucket
      prefix        = "${p}/"
      access_key_id = var.create_access_keys ? aws_iam_access_key.pod[p].id : null
    }
  }
}

output "pod_secret_access_keys" {
  description = "Per-pod secret access keys. Read with `terraform output -json pod_secret_access_keys`."
  value       = var.create_access_keys ? { for p in var.pods : p => aws_iam_access_key.pod[p].secret } : {}
  sensitive   = true
}

output "reader_access_key_id" {
  description = "Read-only access key ID for restores and laptop pulls."
  value       = var.create_reader && var.create_access_keys ? aws_iam_access_key.reader[0].id : null
}

output "reader_secret_access_key" {
  description = "Read-only secret access key. Read with `terraform output -raw reader_secret_access_key`."
  value       = var.create_reader && var.create_access_keys ? aws_iam_access_key.reader[0].secret : null
  sensitive   = true
}
