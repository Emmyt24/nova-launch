##############################################################################
# Staging Environment — Root Module
#
# Wires together all modules for the staging environment.
# Staging uses cost-optimised settings:
#   - Single NAT Gateway
#   - Smaller instance sizes
#   - No multi-AZ RDS
#   - Deletion protection disabled (easy teardown)
##############################################################################

terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  backend "s3" {
    # Values provided via -backend-config or CI/CD environment variables
    # bucket         = "nova-launch-terraform-state"
    # key            = "staging/terraform.tfstate"
    # region         = "us-east-1"
    # dynamodb_table = "nova-launch-terraform-locks"
    # encrypt        = true
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.common_tags
  }
}

locals {
  project     = "nova-launch"
  environment = "staging"

  common_tags = {
    Project     = local.project
    Environment = local.environment
    ManagedBy   = "terraform"
    Repository  = "github.com/Just-Bamford/nova-launch"
  }
}

# ---------------------------------------------------------------------------
# Networking
# ---------------------------------------------------------------------------

module "networking" {
  source = "../../modules/networking"

  project     = local.project
  environment = local.environment

  vpc_cidr             = "10.1.0.0/16"
  availability_zones   = ["${var.aws_region}a", "${var.aws_region}b"]
  public_subnet_cidrs  = ["10.1.0.0/24", "10.1.1.0/24"]
  private_subnet_cidrs = ["10.1.10.0/24", "10.1.11.0/24"]

  # Single NAT to save cost in staging
  single_nat_gateway = true
  log_retention_days = 7

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# ECR
# ---------------------------------------------------------------------------

module "ecr" {
  source = "../../modules/ecr"

  project         = local.project
  environment     = local.environment
  max_image_count = 5

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Secrets Manager
# ---------------------------------------------------------------------------

module "secrets" {
  source = "../../modules/secrets"

  project     = local.project
  environment = local.environment

  jwt_secret          = var.jwt_secret
  admin_jwt_secret    = var.admin_jwt_secret
  db_password         = var.db_password
  redis_auth_token    = var.redis_auth_token
  factory_contract_id = var.factory_contract_id
  ipfs_api_key        = var.ipfs_api_key
  ipfs_api_secret     = var.ipfs_api_secret

  # Immediate deletion in staging (no recovery window needed)
  recovery_window_days = 0

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# RDS PostgreSQL
# ---------------------------------------------------------------------------

module "rds" {
  source = "../../modules/rds"

  project     = local.project
  environment = local.environment

  vpc_id             = module.networking.vpc_id
  private_subnet_ids = module.networking.private_subnet_ids

  allowed_security_group_ids = [module.ecs.backend_security_group_id]

  db_name   = "nova_launch"
  db_username = "nova_user"
  db_password = var.db_password

  instance_class        = "db.t3.micro"
  allocated_storage     = 20
  max_allocated_storage = 50
  engine_version        = "16.3"

  multi_az                = false
  backup_retention_days   = 3
  deletion_protection     = false
  skip_final_snapshot     = true
  log_retention_days      = 7

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# ElastiCache Redis
# ---------------------------------------------------------------------------

module "elasticache" {
  source = "../../modules/elasticache"

  project     = local.project
  environment = local.environment

  vpc_id             = module.networking.vpc_id
  private_subnet_ids = module.networking.private_subnet_ids

  allowed_security_group_ids = [module.ecs.backend_security_group_id]

  node_type       = "cache.t3.micro"
  num_cache_nodes = 1
  engine_version  = "7.1"
  auth_token      = var.redis_auth_token

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Application Load Balancer
# ---------------------------------------------------------------------------

module "alb" {
  source = "../../modules/alb"

  project     = local.project
  environment = local.environment

  vpc_id            = module.networking.vpc_id
  public_subnet_ids = module.networking.public_subnet_ids

  acm_certificate_arn = var.acm_certificate_arn
  aws_account_id      = var.aws_account_id
  log_retention_days  = 30

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# WAF
# ---------------------------------------------------------------------------

module "waf" {
  source = "../../modules/waf"

  project     = local.project
  environment = local.environment
  aws_region  = var.aws_region

  alb_arn                          = module.alb.alb_arn
  rate_limit_requests              = 5000 # More permissive in staging
  log_retention_days               = 7
  blocked_requests_alarm_threshold = 2000

  # Notify on-call when the WAF starts blocking an unusual volume of requests.
  sns_topic_arn = module.monitoring.sns_topic_arn

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# Monitoring
# ---------------------------------------------------------------------------

module "monitoring" {
  source = "../../modules/monitoring"

  project     = local.project
  environment = local.environment
  aws_region  = var.aws_region

  alarm_email = var.alarm_email

  alb_arn_suffix           = module.alb.alb_arn_suffix
  ecs_cluster_name         = module.ecs.cluster_id
  ecs_backend_service_name = module.ecs.backend_service_name
  rds_instance_id          = module.rds.instance_id
  redis_cluster_id         = module.elasticache.cluster_id
  backend_log_group_name   = "/ecs/${local.project}/${local.environment}/backend"

  error_rate_threshold      = 20 # More lenient in staging
  latency_threshold_seconds = 3.0

  tags = local.common_tags
}

# ---------------------------------------------------------------------------
# ECS Fargate
# ---------------------------------------------------------------------------

module "ecs" {
  source = "../../modules/ecs"

  project        = local.project
  environment    = local.environment
  aws_region     = var.aws_region
  aws_account_id = var.aws_account_id

  vpc_id             = module.networking.vpc_id
  private_subnet_ids = module.networking.private_subnet_ids

  alb_security_group_id      = module.alb.alb_security_group_id
  backend_target_group_arn   = module.alb.backend_target_group_arn
  frontend_target_group_arn  = module.alb.frontend_target_group_arn

  backend_ecr_image  = "${module.ecr.backend_repository_url}:${var.backend_image_tag}"
  frontend_ecr_image = "${module.ecr.frontend_repository_url}:${var.frontend_image_tag}"

  # Backend sizing (small for staging)
  backend_cpu           = 256
  backend_memory        = 512
  backend_desired_count = 1
  backend_min_count     = 1
  backend_max_count     = 3

  # Frontend sizing
  frontend_cpu           = 256
  frontend_memory        = 512
  frontend_desired_count = 1

  # Environment
  node_env            = "production"
  port                = "3001"
  stellar_network     = var.stellar_network
  stellar_horizon_url = var.stellar_horizon_url
  frontend_url        = var.frontend_url

  database_url = "postgresql://nova_user:${var.db_password}@${module.rds.address}:5432/nova_launch?sslmode=require"
  redis_url    = module.elasticache.redis_url

  # Secret ARNs
  jwt_secret_arn          = module.secrets.jwt_secret_arn
  admin_jwt_secret_arn    = module.secrets.admin_jwt_secret_arn
  factory_contract_id_arn = module.secrets.factory_contract_id_arn

  log_retention_days = 7

  tags = local.common_tags
}
