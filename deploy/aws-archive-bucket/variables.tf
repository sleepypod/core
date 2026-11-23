variable "bucket_name" {
  description = "Globally unique S3 bucket name for the archive."
  type        = string

  validation {
    condition     = can(regex("^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$", var.bucket_name))
    error_message = "bucket_name must be 3-63 lowercase letters, digits, dots or hyphens."
  }
}

variable "region" {
  description = "AWS region for the bucket. Pick the one closest to the pods."
  type        = string
  default     = "us-east-1"
}

variable "pods" {
  description = "One entry per pod. Each gets its own IAM user, access key and <name>/ prefix."
  type        = list(string)

  validation {
    condition     = length(var.pods) > 0 && alltrue([for p in var.pods : can(regex("^[a-z0-9][a-z0-9-]{0,31}$", p))])
    error_message = "pods must be non-empty; each name is 1-32 lowercase letters, digits or hyphens, starting with a letter or digit."
  }

  validation {
    condition     = length(distinct(var.pods)) == length(var.pods)
    error_message = "pods must not repeat a name."
  }
}

variable "name_prefix" {
  description = "Prefix for IAM user and budget names."
  type        = string
  default     = "sleepypod-archive"
}

variable "create_access_keys" {
  description = "Create access keys in Terraform. The secrets land in the state file; set false to create keys by hand in the console instead."
  type        = bool
  default     = true
}

variable "create_reader" {
  description = "Create a read-only IAM user for restores and for pulling the archive to a laptop."
  type        = bool
  default     = true
}

variable "allowed_source_cidrs" {
  description = "If set, pod keys only work from these public IP ranges (e.g. your home IP as [\"203.0.113.7/32\"]). Leave empty if your ISP rotates your address."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for c in var.allowed_source_cidrs : can(cidrhost(c, 0))])
    error_message = "allowed_source_cidrs entries must be CIDR blocks."
  }
}

variable "enforce_create_only" {
  description = "Pods may only create new objects (PutObject must carry If-None-Match: *), so a leaked pod key cannot overwrite history."
  type        = bool
  default     = true
}

variable "object_lock_days" {
  description = "Governance-mode Object Lock retention for every new object version, in days. 0 disables Object Lock. Decide before the first apply: turning it on later replaces the bucket."
  type        = number
  default     = 30

  validation {
    condition     = var.object_lock_days >= 0 && floor(var.object_lock_days) == var.object_lock_days
    error_message = "object_lock_days must be a whole number >= 0."
  }
}

variable "noncurrent_version_days" {
  description = "Days to keep a version after it is overwritten or deleted."
  type        = number
  default     = 30

  validation {
    condition     = var.noncurrent_version_days >= 1
    error_message = "noncurrent_version_days must be at least 1."
  }
}

variable "raw_transition_days" {
  description = "Move RAW archives to raw_transition_storage_class after this many days. 0 keeps them in STANDARD."
  type        = number
  default     = 30

  validation {
    condition     = var.raw_transition_days >= 0
    error_message = "raw_transition_days must be >= 0."
  }
}

variable "raw_transition_storage_class" {
  description = "Colder class for older RAW archives. GLACIER_IR is cheapest that still reads back instantly; STANDARD_IA costs more to store but less to read."
  type        = string
  default     = "GLACIER_IR"

  validation {
    condition     = contains(["STANDARD_IA", "ONEZONE_IA", "INTELLIGENT_TIERING", "GLACIER_IR"], var.raw_transition_storage_class)
    error_message = "raw_transition_storage_class must be STANDARD_IA, ONEZONE_IA, INTELLIGENT_TIERING or GLACIER_IR."
  }

  validation {
    condition     = !contains(["STANDARD_IA", "ONEZONE_IA"], var.raw_transition_storage_class) || var.raw_transition_days == 0 || var.raw_transition_days >= 30
    error_message = "S3 requires raw_transition_days >= 30 for STANDARD_IA and ONEZONE_IA."
  }
}

variable "raw_expire_days" {
  description = "Delete RAW archives after this many days. 0 keeps them forever (they are the training data)."
  type        = number
  default     = 0

  validation {
    condition     = var.raw_expire_days >= 0
    error_message = "raw_expire_days must be >= 0."
  }
}

variable "db_expire_days" {
  description = "Delete nightly biometrics.db snapshots after this many days. 0 keeps them forever."
  type        = number
  default     = 90

  validation {
    condition     = var.db_expire_days >= 0
    error_message = "db_expire_days must be >= 0."
  }
}

variable "budget_email" {
  description = "If set, email this address when monthly S3 spend passes budget_usd (actual or forecast)."
  type        = string
  default     = ""
}

variable "budget_usd" {
  description = "Monthly S3 budget for the alert, in USD."
  type        = number
  default     = 5
}

variable "tags" {
  description = "Tags applied to every resource."
  type        = map(string)
  default = {
    project = "sleepypod"
    purpose = "biometrics-archive"
  }
}
