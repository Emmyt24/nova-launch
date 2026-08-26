##############################################################################
# Production Environment — Root Module
#
# Production uses HA settings:
#   - Multi-AZ NAT Gateways
#   - Multi-AZ RDS
#   - Larger instance sizes
#   - Deletion protection enabled
#   - Longer log retention
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
    # bucket         = "nova-launch-terraform-state"
    # key            = "production/terraform.tfstate"
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
  environment = "production"

  common_tags = {
    Project     = local.project
    Environment = local.environment
    ManagedBy   = "terraform"
    Repository  = "github.com/Just-Bamford/nova-launch"
  }
}

module "networking" {
  source = "../../modules/networking"

  project     = local.project
  environment = local.environment

  vpc_cidr             = "10.0.0.0/16"
  availability_zones   = ["${var.aws_region}a", "${var.aws_region}b"]
  public_subnet_cidrs  = ["10.0.0.0/24", "10.0.1.0/24"]
  private_subnet_cidrs = ["10.0.10.0/24", "10.0.11.0/24"]

  # One NAT per AZ for HA
  single_nat_gateway = false
  log_retention_days = 90

  tags = local.common_tags
}

module "ecr" {
  source = "../../modules/ecr"

  project         = local.project
  environment     = local.environment
  max_image_count = 10

  tags = local.common_tags
}

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

  recovery_window_days = 7

  tags = local.common_tags
}

module "rds" {
  source = "../../modules/rds"

  project     = local.project
  environment = local.environment

  vpc_id             = module.networking.vpc_id
  private_subnet_ids = module.networking.private_subnet_ids

  allowed_security_group_ids = [module.ecs.backend_security_group_id]

  db_name     = "nova_launch"
  db_username = "nova_user"
  db_password = var.db_password

  instance_class        = "db.t3.small"
  allocated_storage     = 50
  max_allocated_storage = 500
  engine_version        = "16.3"

  multi_az              = true
  backup_retention_days = 14
  deletion_protection   = true
  skip_final_snapshot   = false
  log_retention_days    = 90

  tags = local.common_tags
}

module "elasticache" {
  source = "../../modules/elasticache"

  project     = local.project
  environment = local.environment

  vpc_id             = module.networking.vpc_id
  private_subnet_ids = module.networking.private_subnet_ids

  allowed_security_group_ids = [module.ecs.backend_security_group_id]

  node_type       = "cache.t3.small"
  num_cache_nodes = 1
  engine_version  = "7.1"
  auth_token      = var.redis_auth_token

  tags = local.common_tags
}

module "alb" {
  source = "../../modules/alb"

  project     = local.project
  environment = local.environment

  vpc_id            = module.networking.vpc_id
  public_subnet_ids = module.networking.public_subnet_ids

  acm_certificate_arn = var.acm_certificate_arn
  aws_account_id      = var.aws_account_id
  log_retention_days  = 90

  tags = local.common_tags
}

module "waf" {
  source = "../../modules/waf"

  project     = local.project
  environment = local.environment
  aws_region  = var.aws_region

  alb_arn                          = module.alb.alb_arn
  rate_limit_requests              = 2000
  log_retention_days               = 90
  blocked_requests_alarm_threshold = 500

  # Notify on-call when the WAF starts blocking an unusual volume of requests.
  sns_topic_arn = module.monitoring.sns_topic_arn

  tags = local.common_tags
}

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
  rds_log_group_name       = "/aws/rds/instance/${local.project}-${local.environment}-postgres/postgresql"

  error_rate_threshold      = 5
  latency_threshold_seconds = 1.5

  tags = local.common_tags
}

module "ecs" {
  source = "../../modules/ecs"

  project        = local.project
  environment    = local.environment
  aws_region     = var.aws_region
  aws_account_id = var.aws_account_id

  vpc_id             = module.networking.vpc_id
  private_subnet_ids = module.networking.private_subnet_ids

  alb_security_group_id     = module.alb.alb_security_group_id
  backend_target_group_arn  = module.alb.backend_target_group_arn
  frontend_target_group_arn = module.alb.frontend_target_group_arn

  backend_ecr_image  = "${module.ecr.backend_repository_url}:${var.backend_image_tag}"
  frontend_ecr_image = "${module.ecr.frontend_repository_url}:${var.frontend_image_tag}"

  backend_cpu           = 1024
  backend_memory        = 2048
  backend_desired_count = 2
  backend_min_count     = 2
  backend_max_count     = 20

  frontend_cpu           = 512
  frontend_memory        = 1024
  frontend_desired_count = 2

  node_env            = "production"
  port                = "3001"
  stellar_network     = var.stellar_network
  stellar_horizon_url = var.stellar_horizon_url
  frontend_url        = var.frontend_url

  database_url = "postgresql://nova_user:${var.db_password}@${module.rds.address}:5432/nova_launch?sslmode=require"
  redis_url    = module.elasticache.redis_url

  jwt_secret_arn          = module.secrets.jwt_secret_arn
  admin_jwt_secret_arn    = module.secrets.admin_jwt_secret_arn
  factory_contract_id_arn = module.secrets.factory_contract_id_arn

  log_retention_days = 90

  tags = local.common_tags
}
