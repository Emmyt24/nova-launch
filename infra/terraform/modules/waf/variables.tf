##############################################################################
# Module: waf — Variables
##############################################################################

variable "project" {
  description = "Project name used as a prefix for all resource names"
  type        = string
}

variable "environment" {
  description = "Deployment environment (staging | production)"
  type        = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be 'staging' or 'production'."
  }
}

variable "aws_region" {
  description = "AWS region where the WAF is deployed"
  type        = string
  default     = "us-east-1"
}

variable "alb_arn" {
  description = "ARN of the ALB to associate the WAF Web ACL with"
  type        = string
}

variable "rate_limit_requests" {
  description = "Maximum number of requests per 5-minute window per IP before blocking"
  type        = number
  default     = 2000

  validation {
    condition     = var.rate_limit_requests >= 100
    error_message = "rate_limit_requests must be at least 100."
  }
}

variable "allowed_countries" {
  description = "ISO 3166-1 alpha-2 country codes to allow. Empty list disables geo-blocking."
  type        = list(string)
  default     = []
}

variable "log_retention_days" {
  description = "CloudWatch log retention in days for WAF logs"
  type        = number
  default     = 90
}

variable "blocked_requests_alarm_threshold" {
  description = "Number of blocked requests per 5-minute period that triggers a CloudWatch alarm"
  type        = number
  default     = 1000
}

variable "sns_topic_arn" {
  description = "Optional SNS topic ARN to notify when the waf_blocked_requests alarm changes state. Empty string disables notifications (module works standalone)."
  type        = string
  default     = ""
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
