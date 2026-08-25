##############################################################################
# Module: monitoring — Variables
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
  description = "AWS region"
  type        = string
  default     = "us-east-1"
}

variable "alarm_email" {
  description = "Email address to receive CloudWatch alarm notifications. Leave empty to skip."
  type        = string
  default     = ""
}

variable "alarm_emails" {
  description = "List of email addresses to receive CloudWatch alarm notifications. Use this for multiple subscribers."
  type        = list(string)
  default     = []
}

variable "alb_arn_suffix" {
  description = "ALB ARN suffix (the part after 'app/') used in CloudWatch dimensions"
  type        = string
}

variable "ecs_cluster_name" {
  description = "Name of the ECS cluster"
  type        = string
}

variable "ecs_backend_service_name" {
  description = "Name of the ECS backend service"
  type        = string
}

variable "rds_instance_id" {
  description = "RDS instance identifier"
  type        = string
}

variable "redis_cluster_id" {
  description = "ElastiCache cluster ID"
  type        = string
}

variable "backend_log_group_name" {
  description = "CloudWatch log group name for the backend ECS service"
  type        = string
}

variable "rds_log_group_name" {
  description = "CloudWatch log group name for RDS PostgreSQL logs. Leave empty to skip."
  type        = string
  default     = ""
}

variable "error_rate_threshold" {
  description = "Number of 5xx errors per minute that triggers an alarm"
  type        = number
  default     = 10
}

variable "latency_threshold_seconds" {
  description = "p99 response time in seconds that triggers a latency alarm"
  type        = number
  default     = 2.0
}

variable "tags" {
  description = "Tags to apply to all resources"
  type        = map(string)
  default     = {}
}
