terraform {
  required_version = ">= 1.6"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 6.0, < 7.0"
    }
  }

  # State stays local on purpose: it holds the pods' secret access keys.
  # See README.md before pointing this at a remote backend.
}

provider "aws" {
  region = var.region

  default_tags {
    tags = var.tags
  }
}
