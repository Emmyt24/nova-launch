##############################################################################
# Module: monitoring
#
# Creates CloudWatch dashboards, composite alarms, SNS notification topics,
# and log metric filters for the Nova Launch platform.
#
# Resources:
#   - SNS topic for alarm notifications (email + optional PagerDuty)
#   - CloudWatch dashboard: API overview (latency, error rate, throughput)
#   - CloudWatch dashboard: Infrastructure (ECS CPU/memory, RDS, Redis)
#   - Composite alarm: "Platform Degraded" (any critical alarm fires)
#   - Log metric filters: 5xx errors, auth failures, slow queries
#   - CloudWatch Insights query groups for common investigations
#
# Design:
#   - All alarms feed into a single SNS topic for unified alerting
#   - Composite alarm prevents alert storms (one notification per incident)
#   - Dashboards are environment-aware (staging vs production thresholds)
##############################################################################

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

locals {
  name_prefix      = "${var.project}-${var.environment}"
  alarm_email_list = flatten([
    var.alarm_email != "" ? [var.alarm_email] : [],
    var.alarm_emails,
  ])
  unique_alarm_emails = toset(local.alarm_email_list)
}

# ---------------------------------------------------------------------------
# SNS Topic — Alarm Notifications
# ---------------------------------------------------------------------------

resource "aws_sns_topic" "alarms" {
  name              = "${local.name_prefix}-alarms"
  kms_master_key_id = "alias/aws/sns" # Encrypt SNS messages at rest

  tags = merge(var.tags, {
    Name = "${local.name_prefix}-alarms"
  })
}

resource "aws_sns_topic_policy" "alarms" {
  arn = aws_sns_topic.alarms.arn

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "AllowCloudWatchAlarms"
        Effect = "Allow"
        Principal = {
          Service = "cloudwatch.amazonaws.com"
        }
        Action   = "SNS:Publish"
        Resource = aws_sns_topic.alarms.arn
      }
    ]
  })
}

# Email subscription (optional — only created when email(s) are provided)
resource "aws_sns_topic_subscription" "email" {
  for_each = local.unique_alarm_emails

  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = each.value
}

# ---------------------------------------------------------------------------
# CloudWatch Log Metric Filters
# ---------------------------------------------------------------------------

# Filter: count HTTP 5xx errors from backend logs
resource "aws_cloudwatch_log_metric_filter" "backend_5xx" {
  name           = "${local.name_prefix}-backend-5xx"
  pattern        = "[timestamp, requestId, level, ..., statusCode=5*]"
  log_group_name = var.backend_log_group_name

  metric_transformation {
    name          = "Backend5xxErrors"
    namespace     = "NovaLaunch/${var.environment}"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Filter: count authentication failures
resource "aws_cloudwatch_log_metric_filter" "auth_failures" {
  name           = "${local.name_prefix}-auth-failures"
  pattern        = "\"authentication failed\" OR \"invalid token\" OR \"unauthorized\""
  log_group_name = var.backend_log_group_name

  metric_transformation {
    name          = "AuthFailures"
    namespace     = "NovaLaunch/${var.environment}"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# Filter: count slow database queries (> 1 second, from RDS logs)
resource "aws_cloudwatch_log_metric_filter" "slow_queries" {
  count = var.rds_log_group_name != "" ? 1 : 0

  name           = "${local.name_prefix}-slow-queries"
  pattern        = "duration: * ms"
  log_group_name = var.rds_log_group_name

  metric_transformation {
    name          = "SlowQueries"
    namespace     = "NovaLaunch/${var.environment}"
    value         = "1"
    default_value = "0"
    unit          = "Count"
  }
}

# ---------------------------------------------------------------------------
# CloudWatch Alarms — Application
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "backend_5xx_rate" {
  alarm_name          = "${local.name_prefix}-backend-5xx-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "Backend5xxErrors"
  namespace           = "NovaLaunch/${var.environment}"
  period              = 60
  statistic           = "Sum"
  threshold           = var.error_rate_threshold
  alarm_description   = "Backend 5xx error rate exceeds threshold"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "alb_5xx_rate" {
  alarm_name          = "${local.name_prefix}-alb-5xx-rate"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = var.error_rate_threshold
  alarm_description   = "ALB target 5xx errors exceed threshold"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "alb_latency_p99" {
  alarm_name          = "${local.name_prefix}-alb-latency-p99"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  extended_statistic  = "p99"
  metric_name         = "TargetResponseTime"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  threshold           = var.latency_threshold_seconds
  alarm_description   = "ALB p99 response time exceeds ${var.latency_threshold_seconds}s"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    LoadBalancer = var.alb_arn_suffix
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "auth_failure_spike" {
  alarm_name          = "${local.name_prefix}-auth-failure-spike"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "AuthFailures"
  namespace           = "NovaLaunch/${var.environment}"
  period              = 300
  statistic           = "Sum"
  threshold           = 100
  alarm_description   = "High authentication failure rate — possible brute-force attack"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"

  tags = var.tags
}

# ---------------------------------------------------------------------------
# CloudWatch Alarms — ECS
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "ecs_backend_cpu" {
  alarm_name          = "${local.name_prefix}-ecs-backend-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "CPUUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 85
  alarm_description   = "ECS backend CPU utilization exceeds 85%"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = var.ecs_backend_service_name
  }

  tags = var.tags
}

resource "aws_cloudwatch_metric_alarm" "ecs_backend_memory" {
  alarm_name          = "${local.name_prefix}-ecs-backend-memory"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "MemoryUtilization"
  namespace           = "AWS/ECS"
  period              = 60
  statistic           = "Average"
  threshold           = 90
  alarm_description   = "ECS backend memory utilization exceeds 90%"
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  treat_missing_data  = "notBreaching"

  dimensions = {
    ClusterName = var.ecs_cluster_name
    ServiceName = var.ecs_backend_service_name
  }

  tags = var.tags
}

# ---------------------------------------------------------------------------
# Composite Alarm — "Platform Degraded"
# Fires when ANY critical alarm is in ALARM state.
# Prevents alert storms by sending one notification per incident.
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_composite_alarm" "platform_degraded" {
  alarm_name        = "${local.name_prefix}-platform-degraded"
  alarm_description = "One or more critical Nova Launch alarms are firing"

  alarm_rule = join(" OR ", [
    "ALARM(\"${aws_cloudwatch_metric_alarm.backend_5xx_rate.alarm_name}\")",
    "ALARM(\"${aws_cloudwatch_metric_alarm.alb_5xx_rate.alarm_name}\")",
    "ALARM(\"${aws_cloudwatch_metric_alarm.alb_latency_p99.alarm_name}\")",
    "ALARM(\"${aws_cloudwatch_metric_alarm.ecs_backend_cpu.alarm_name}\")",
    "ALARM(\"${aws_cloudwatch_metric_alarm.ecs_backend_memory.alarm_name}\")",
  ])

  alarm_actions = [aws_sns_topic.alarms.arn]
  ok_actions    = [aws_sns_topic.alarms.arn]

  tags = var.tags
}

# ---------------------------------------------------------------------------
# CloudWatch Dashboard — API Overview
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "api" {
  dashboard_name = "${local.name_prefix}-api"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Request Rate (req/min)"
          view   = "timeSeries"
          region = var.aws_region
          metrics = [
            ["AWS/ApplicationELB", "RequestCount", "LoadBalancer", var.alb_arn_suffix,
            { stat = "Sum", period = 60, label = "Total Requests" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "Response Time (p50 / p95 / p99)"
          view   = "timeSeries"
          region = var.aws_region
          metrics = [
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix,
            { stat = "p50", period = 60, label = "p50" }],
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix,
            { stat = "p95", period = 60, label = "p95" }],
            ["AWS/ApplicationELB", "TargetResponseTime", "LoadBalancer", var.alb_arn_suffix,
            { stat = "p99", period = 60, label = "p99" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "HTTP Error Rates"
          view   = "timeSeries"
          region = var.aws_region
          metrics = [
            ["AWS/ApplicationELB", "HTTPCode_Target_4XX_Count", "LoadBalancer", var.alb_arn_suffix,
            { stat = "Sum", period = 60, label = "4xx" }],
            ["AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", "LoadBalancer", var.alb_arn_suffix,
            { stat = "Sum", period = 60, label = "5xx" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "Healthy Host Count"
          view   = "timeSeries"
          region = var.aws_region
          metrics = [
            ["AWS/ApplicationELB", "HealthyHostCount", "LoadBalancer", var.alb_arn_suffix,
            { stat = "Average", period = 60, label = "Healthy Hosts" }],
            ["AWS/ApplicationELB", "UnHealthyHostCount", "LoadBalancer", var.alb_arn_suffix,
            { stat = "Average", period = 60, label = "Unhealthy Hosts" }]
          ]
        }
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# CloudWatch Dashboard — Infrastructure
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_dashboard" "infrastructure" {
  dashboard_name = "${local.name_prefix}-infrastructure"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "ECS Backend — CPU & Memory"
          view   = "timeSeries"
          region = var.aws_region
          metrics = [
            ["AWS/ECS", "CPUUtilization", "ClusterName", var.ecs_cluster_name,
            "ServiceName", var.ecs_backend_service_name,
            { stat = "Average", period = 60, label = "CPU %" }],
            ["AWS/ECS", "MemoryUtilization", "ClusterName", var.ecs_cluster_name,
            "ServiceName", var.ecs_backend_service_name,
            { stat = "Average", period = 60, label = "Memory %" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          title  = "RDS — CPU & Connections"
          view   = "timeSeries"
          region = var.aws_region
          metrics = [
            ["AWS/RDS", "CPUUtilization", "DBInstanceIdentifier", var.rds_instance_id,
            { stat = "Average", period = 60, label = "CPU %" }],
            ["AWS/RDS", "DatabaseConnections", "DBInstanceIdentifier", var.rds_instance_id,
            { stat = "Average", period = 60, label = "Connections" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "RDS — Storage & IOPS"
          view   = "timeSeries"
          region = var.aws_region
          metrics = [
            ["AWS/RDS", "FreeStorageSpace", "DBInstanceIdentifier", var.rds_instance_id,
            { stat = "Average", period = 300, label = "Free Storage (bytes)" }],
            ["AWS/RDS", "ReadIOPS", "DBInstanceIdentifier", var.rds_instance_id,
            { stat = "Average", period = 60, label = "Read IOPS" }],
            ["AWS/RDS", "WriteIOPS", "DBInstanceIdentifier", var.rds_instance_id,
            { stat = "Average", period = 60, label = "Write IOPS" }]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          title  = "ElastiCache Redis — Memory & Connections"
          view   = "timeSeries"
          region = var.aws_region
          metrics = [
            ["AWS/ElastiCache", "DatabaseMemoryUsagePercentage",
            "CacheClusterId", var.redis_cluster_id,
            { stat = "Average", period = 60, label = "Memory %" }],
            ["AWS/ElastiCache", "CurrConnections", "CacheClusterId", var.redis_cluster_id,
            { stat = "Average", period = 60, label = "Connections" }]
          ]
        }
      }
    ]
  })
}

# ---------------------------------------------------------------------------
# CloudWatch Insights Query Definitions
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_query_definition" "backend_errors" {
  name = "${local.name_prefix}/backend-errors"

  log_group_names = [var.backend_log_group_name]

  query_string = <<-EOT
    fields @timestamp, @message, statusCode, method, path, duration
    | filter statusCode >= 500
    | sort @timestamp desc
    | limit 100
  EOT
}

resource "aws_cloudwatch_query_definition" "slow_requests" {
  name = "${local.name_prefix}/slow-requests"

  log_group_names = [var.backend_log_group_name]

  query_string = <<-EOT
    fields @timestamp, method, path, duration, statusCode
    | filter duration > 1000
    | sort duration desc
    | limit 50
  EOT
}

resource "aws_cloudwatch_query_definition" "auth_failures_query" {
  name = "${local.name_prefix}/auth-failures"

  log_group_names = [var.backend_log_group_name]

  query_string = <<-EOT
    fields @timestamp, @message, sourceIp, userId
    | filter @message like /authentication failed|invalid token|unauthorized/i
    | stats count(*) as failures by sourceIp
    | sort failures desc
    | limit 20
  EOT
}
