locals {
  pods = toset(var.pods)

  # Lifecycle rules need at least one action, so each is only emitted when its
  # knobs ask for something.
  raw_rule_pods = var.raw_transition_days > 0 || var.raw_expire_days > 0 ? local.pods : toset([])
  db_rule_pods  = var.db_expire_days > 0 ? local.pods : toset([])
}

resource "aws_s3_bucket" "archive" {
  bucket = var.bucket_name

  # Health data: never let `terraform destroy` empty the bucket.
  force_destroy       = false
  object_lock_enabled = var.object_lock_days > 0
}

resource "aws_s3_bucket_public_access_block" "archive" {
  bucket = aws_s3_bucket.archive.id

  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_versioning" "archive" {
  bucket = aws_s3_bucket.archive.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_object_lock_configuration" "archive" {
  count  = var.object_lock_days > 0 ? 1 : 0
  bucket = aws_s3_bucket.archive.id

  rule {
    default_retention {
      mode = "GOVERNANCE"
      days = var.object_lock_days
    }
  }

  depends_on = [aws_s3_bucket_versioning.archive]
}

resource "aws_s3_bucket_lifecycle_configuration" "archive" {
  bucket = aws_s3_bucket.archive.id

  rule {
    id     = "abort-incomplete-uploads"
    status = "Enabled"
    filter {}

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  rule {
    id     = "expire-noncurrent-versions"
    status = "Enabled"
    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_days
    }

    expiration {
      expired_object_delete_marker = true
    }
  }

  dynamic "rule" {
    for_each = local.raw_rule_pods

    content {
      id     = "${rule.value}-raw"
      status = "Enabled"

      filter {
        prefix = "${rule.value}/raw/"
      }

      dynamic "transition" {
        for_each = var.raw_transition_days > 0 ? [1] : []

        content {
          days          = var.raw_transition_days
          storage_class = var.raw_transition_storage_class
        }
      }

      dynamic "expiration" {
        for_each = var.raw_expire_days > 0 ? [1] : []

        content {
          days = var.raw_expire_days
        }
      }
    }
  }

  dynamic "rule" {
    for_each = local.db_rule_pods

    content {
      id     = "${rule.value}-db"
      status = "Enabled"

      filter {
        prefix = "${rule.value}/db/"
      }

      expiration {
        days = var.db_expire_days
      }
    }
  }

  # The Test button writes one small object per press.
  dynamic "rule" {
    for_each = local.pods

    content {
      id     = "${rule.value}-probe"
      status = "Enabled"

      filter {
        prefix = "${rule.value}/probe/"
      }

      expiration {
        days = 1
      }
    }
  }

  depends_on = [aws_s3_bucket_versioning.archive]
}

data "aws_iam_policy_document" "bucket" {
  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.archive.arn, "${aws_s3_bucket.archive.arn}/*"]

    principals {
      type        = "*"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "archive" {
  bucket = aws_s3_bucket.archive.id
  policy = data.aws_iam_policy_document.bucket.json

  depends_on = [aws_s3_bucket_public_access_block.archive]
}
