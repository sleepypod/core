# Pod keys can list and create objects under their own prefix and nothing
# else: no reads, no deletes, no other pod's prefix. A key lifted from a pod
# (or from the LAN-reachable settings API) can add junk but cannot read or
# erase the history. Retention is the bucket's lifecycle rules, never the pod.

resource "aws_iam_user" "pod" {
  for_each = local.pods

  name = "${var.name_prefix}-${each.key}"
  path = "/sleepypod/"
}

data "aws_iam_policy_document" "pod" {
  for_each = local.pods

  statement {
    sid       = "ListOwnPrefix"
    actions   = ["s3:ListBucket"]
    resources = [aws_s3_bucket.archive.arn]

    condition {
      test     = "StringLike"
      variable = "s3:prefix"
      values   = ["${each.key}/*"]
    }
  }

  statement {
    sid       = "CreateUnderOwnPrefix"
    actions   = ["s3:PutObject"]
    resources = ["${aws_s3_bucket.archive.arn}/${each.key}/*"]
  }

  dynamic "statement" {
    for_each = var.enforce_create_only ? [1] : []

    content {
      sid       = "DenyOverwrite"
      effect    = "Deny"
      actions   = ["s3:PutObject"]
      resources = ["${aws_s3_bucket.archive.arn}/*"]

      condition {
        test     = "Null"
        variable = "s3:if-none-match"
        values   = ["true"]
      }
    }
  }

  dynamic "statement" {
    for_each = length(var.allowed_source_cidrs) > 0 ? [1] : []

    content {
      sid       = "DenyOutsideAllowedNetworks"
      effect    = "Deny"
      actions   = ["s3:*"]
      resources = [aws_s3_bucket.archive.arn, "${aws_s3_bucket.archive.arn}/*"]

      condition {
        test     = "NotIpAddress"
        variable = "aws:SourceIp"
        values   = var.allowed_source_cidrs
      }
    }
  }
}

resource "aws_iam_user_policy" "pod" {
  for_each = local.pods

  name   = "archive-push"
  user   = aws_iam_user.pod[each.key].name
  policy = data.aws_iam_policy_document.pod[each.key].json
}

resource "aws_iam_access_key" "pod" {
  for_each = var.create_access_keys ? local.pods : toset([])

  user = aws_iam_user.pod[each.key].name
}

resource "aws_iam_user" "reader" {
  count = var.create_reader ? 1 : 0

  name = "${var.name_prefix}-reader"
  path = "/sleepypod/"
}

data "aws_iam_policy_document" "reader" {
  statement {
    sid       = "ListArchive"
    actions   = ["s3:ListBucket", "s3:ListBucketVersions"]
    resources = [aws_s3_bucket.archive.arn]
  }

  statement {
    sid       = "ReadArchive"
    actions   = ["s3:GetObject", "s3:GetObjectVersion"]
    resources = ["${aws_s3_bucket.archive.arn}/*"]
  }
}

resource "aws_iam_user_policy" "reader" {
  count = var.create_reader ? 1 : 0

  name   = "archive-read"
  user   = aws_iam_user.reader[0].name
  policy = data.aws_iam_policy_document.reader.json
}

resource "aws_iam_access_key" "reader" {
  count = var.create_reader && var.create_access_keys ? 1 : 0

  user = aws_iam_user.reader[0].name
}
