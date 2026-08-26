##############################################################################
# Module: waf
#
# Creates an AWS WAFv2 Web ACL and associates it with the ALB.
#
# Managed rule groups included (OWASP-aligned):
#   - AWSManagedRulesCommonRuleSet       — OWASP Top 10 core rules
#   - AWSManagedRulesKnownBadInputsRuleSet — Log4j, SSRF, path traversal
#   - AWSManagedRulesSQLiRuleSet         — SQL injection
#   - AWSManagedRulesAmazonIpReputationList — Known malicious IPs
#
# Custom rules:
#   - Rate limiting: 2000 req/5min per IP (blocks brute-force / DDoS)
#   - Geo-blocking: optional allowlist of permitted countries
#
# Security notes:
#   - All rules default to BLOCK (not COUNT) in production
#   - Logging to CloudWatch for audit trail
#   - Metrics enabled for all rules
##############################################################################

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

# ---------------------------------------------------------------------------
# WAF Web ACL
# ---------------------------------------------------------------------------

resource "aws_wafv2_web_acl" "main" {
  name        = "${var.project}-${var.environment}-waf"
  description = "WAF Web ACL for Nova Launch ${var.environment} ALB"
  scope       = "REGIONAL" # REGIONAL for ALB; CLOUDFRONT for CloudFront

  default_action {
    allow {}
  }

  # -------------------------------------------------------------------------
  # Rule 1: AWS Managed — Common Rule Set (OWASP Top 10)
  # -------------------------------------------------------------------------
  rule {
    name     = "AWSManagedRulesCommonRuleSet"
    priority = 10

    override_action {
      none {} # Use the managed rule group's own actions (BLOCK)
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesCommonRuleSet"
        vendor_name = "AWS"

        # Exclude rules that commonly cause false positives in API backends
        rule_action_override {
          name = "SizeRestrictions_BODY"
          action_to_use {
            count {} # Count only — large request bodies are valid for file uploads
          }
        }
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-${var.environment}-common-rules"
      sampled_requests_enabled   = true
    }
  }

  # -------------------------------------------------------------------------
  # Rule 2: AWS Managed — Known Bad Inputs (Log4j, SSRF, path traversal)
  # -------------------------------------------------------------------------
  rule {
    name     = "AWSManagedRulesKnownBadInputsRuleSet"
    priority = 20

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesKnownBadInputsRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-${var.environment}-bad-inputs"
      sampled_requests_enabled   = true
    }
  }

  # -------------------------------------------------------------------------
  # Rule 3: AWS Managed — SQL Injection
  # -------------------------------------------------------------------------
  rule {
    name     = "AWSManagedRulesSQLiRuleSet"
    priority = 30

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesSQLiRuleSet"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-${var.environment}-sqli"
      sampled_requests_enabled   = true
    }
  }

  # -------------------------------------------------------------------------
  # Rule 4: AWS Managed — IP Reputation List (known malicious IPs)
  # -------------------------------------------------------------------------
  rule {
    name     = "AWSManagedRulesAmazonIpReputationList"
    priority = 40

    override_action {
      none {}
    }

    statement {
      managed_rule_group_statement {
        name        = "AWSManagedRulesAmazonIpReputationList"
        vendor_name = "AWS"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-${var.environment}-ip-reputation"
      sampled_requests_enabled   = true
    }
  }

  # -------------------------------------------------------------------------
  # Rule 5: Rate limiting — 2000 requests per 5 minutes per IP
  # Protects against brute-force attacks and DDoS
  # -------------------------------------------------------------------------
  rule {
    name     = "RateLimitPerIP"
    priority = 50

    action {
      block {}
    }

    statement {
      rate_based_statement {
        limit              = var.rate_limit_requests
        aggregate_key_type = "IP"
      }
    }

    visibility_config {
      cloudwatch_metrics_enabled = true
      metric_name                = "${var.project}-${var.environment}-rate-limit"
      sampled_requests_enabled   = true
    }
  }

  # -------------------------------------------------------------------------
  # Rule 6: Geo-blocking (optional — only applied when country list is set)
  # -------------------------------------------------------------------------
  dynamic "rule" {
    for_each = length(var.allowed_countries) > 0 ? [1] : []

    content {
      name     = "GeoBlockNonAllowedCountries"
      priority = 60

      action {
        block {}
      }

      statement {
        not_statement {
          statement {
            geo_match_statement {
              country_codes = var.allowed_countries
            }
          }
        }
      }

      visibility_config {
        cloudwatch_metrics_enabled = true
        metric_name                = "${var.project}-${var.environment}-geo-block"
        sampled_requests_enabled   = true
      }
    }
  }

  visibility_config {
    cloudwatch_metrics_enabled = true
    metric_name                = "${var.project}-${var.environment}-waf"
    sampled_requests_enabled   = true
  }

  tags = merge(var.tags, {
    Name = "${var.project}-${var.environment}-waf"
  })
}

# ---------------------------------------------------------------------------
# Associate WAF with ALB
# ---------------------------------------------------------------------------

resource "aws_wafv2_web_acl_association" "alb" {
  resource_arn = var.alb_arn
  web_acl_arn  = aws_wafv2_web_acl.main.arn
}

# ---------------------------------------------------------------------------
# WAF Logging — CloudWatch Log Group
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_log_group" "waf" {
  # WAF log group names MUST start with "aws-waf-logs-"
  name              = "aws-waf-logs-${var.project}-${var.environment}"
  retention_in_days = var.log_retention_days

  tags = merge(var.tags, {
    Name = "aws-waf-logs-${var.project}-${var.environment}"
  })
}

resource "aws_wafv2_web_acl_logging_configuration" "main" {
  log_destination_configs = [aws_cloudwatch_log_group.waf.arn]
  resource_arn            = aws_wafv2_web_acl.main.arn

  # Redact sensitive fields from WAF logs (OWASP best practice)
  redacted_fields {
    single_header {
      name = "authorization"
    }
  }

  redacted_fields {
    single_header {
      name = "cookie"
    }
  }
}

# ---------------------------------------------------------------------------
# CloudWatch Alarms — WAF blocked requests
# ---------------------------------------------------------------------------

resource "aws_cloudwatch_metric_alarm" "waf_blocked_requests" {
  alarm_name          = "${var.project}-${var.environment}-waf-blocked-high"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 2
  metric_name         = "BlockedRequests"
  namespace           = "AWS/WAFV2"
  period              = 300
  statistic           = "Sum"
  threshold           = var.blocked_requests_alarm_threshold
  alarm_description   = "WAF is blocking an unusually high number of requests — possible attack in progress"

  dimensions = {
    WebACL = aws_wafv2_web_acl.main.name
    Region = var.aws_region
    Rule   = "ALL"
  }

  # Wire the alarm into the shared SNS alerting path when a topic ARN is
  # supplied. An empty value disables notifications so the module still works
  # standalone (e.g. isolated terraform plan runs).
  alarm_actions = var.sns_topic_arn != "" ? [var.sns_topic_arn] : []
  ok_actions    = var.sns_topic_arn != "" ? [var.sns_topic_arn] : []

  tags = var.tags
}
