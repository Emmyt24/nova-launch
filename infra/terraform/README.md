# Nova Launch — Terraform Infrastructure as Code

Provisions the complete AWS cloud infrastructure for Nova Launch using
Terraform. The stack is split into reusable modules and two top-level
environments (`staging` and `production`).

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  AWS Account                                                         │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  VPC  (10.0.0.0/16)                                          │   │
│  │                                                              │   │
│  │  ┌─────────────────┐    ┌─────────────────┐                 │   │
│  │  │  Public Subnets │    │  Private Subnets │                 │   │
│  │  │  (2 AZs)        │    │  (2 AZs)         │                 │   │
│  │  │                 │    │                  │                 │   │
│  │  │  ┌───────────┐  │    │  ┌────────────┐  │                 │   │
│  │  │  │    ALB    │  │    │  │  ECS       │  │                 │   │
│  │  │  │  (HTTPS)  │  │    │  │  Fargate   │  │                 │   │
│  │  │  └─────┬─────┘  │    │  │  Backend   │  │                 │   │
│  │  └────────┼────────┘    │  └─────┬──────┘  │                 │   │
│  │           │             │        │          │                 │   │
│  │           └─────────────┼────────┘          │                 │   │
│  │                         │                   │                 │   │
│  │                         │  ┌────────────┐   │                 │   │
│  │                         │  │  RDS       │   │                 │   │
│  │                         │  │  Postgres  │   │                 │   │
│  │                         │  └────────────┘   │                 │   │
│  │                         │                   │                 │   │
│  │                         │  ┌────────────┐   │                 │   │
│  │                         │  │ ElastiCache│   │                 │   │
│  │                         │  │   Redis    │   │                 │   │
│  │                         │  └────────────┘   │                 │   │
│  │                         └───────────────────┘                 │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  Supporting Services                                          │   │
│  │  ECR (container registry)  │  Secrets Manager                │   │
│  │  CloudWatch (logs/alarms)  │  S3 (Terraform state)           │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

## Module Structure

```
infra/terraform/
├── README.md                    # This file
├── modules/
│   ├── networking/              # VPC, subnets, IGW, NAT, route tables
│   ├── ecs/                     # ECS cluster, task definitions, services
│   ├── rds/                     # PostgreSQL RDS instance
│   ├── elasticache/             # Redis ElastiCache cluster
│   ├── ecr/                     # Container registry
│   ├── alb/                     # Application Load Balancer + ACM
│   ├── secrets/                 # AWS Secrets Manager entries
│   └── monitoring/              # CloudWatch dashboards, alarms, log groups
├── environments/
│   ├── staging/                 # Staging environment root module
│   │   ├── main.tf
│   │   ├── variables.tf
│   │   ├── outputs.tf
│   │   └── terraform.tfvars.example
│   └── production/              # Production environment root module
│       ├── main.tf
│       ├── variables.tf
│       ├── outputs.tf
│       └── terraform.tfvars.example
└── tests/
    ├── unit/                    # Terraform validate + fmt checks
    └── integration/             # Terratest Go tests
```

## Prerequisites

- Terraform >= 1.7.0
- AWS CLI configured with appropriate credentials
- An S3 bucket for Terraform state (see bootstrap below)
- A DynamoDB table for state locking

## Bootstrap (first time only)

```bash
# Create S3 state bucket and DynamoDB lock table
aws s3api create-bucket \
  --bucket nova-launch-terraform-state \
  --region us-east-1

aws s3api put-bucket-versioning \
  --bucket nova-launch-terraform-state \
  --versioning-configuration Status=Enabled

aws s3api put-bucket-encryption \
  --bucket nova-launch-terraform-state \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

aws dynamodb create-table \
  --table-name nova-launch-terraform-locks \
  --attribute-definitions AttributeName=LockID,AttributeType=S \
  --key-schema AttributeName=LockID,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1
```

## Usage

```bash
# Staging
cd infra/terraform/environments/staging
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars with your values
terraform init
terraform plan -out=tfplan
terraform apply tfplan

# Production
cd infra/terraform/environments/production
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform plan -out=tfplan
terraform apply tfplan
```

## Destroying Infrastructure

```bash
# Always plan destroy first
terraform plan -destroy -out=destroy.tfplan
terraform apply destroy.tfplan
```

## Security Notes

- All secrets are stored in AWS Secrets Manager, never in `.tfvars` files
- RDS and ElastiCache are in private subnets with no public access
- Security groups follow least-privilege (only required ports open)
- ECS tasks run with minimal IAM permissions
- ALB enforces HTTPS with TLS 1.2+ and redirects HTTP → HTTPS
- Terraform state is encrypted at rest in S3 with versioning enabled
- State locking via DynamoDB prevents concurrent modifications
- CloudWatch alarm notifications can be sent to multiple email subscribers via the `alarm_emails` list in the monitoring module

## Required GitHub Actions Secrets

| Secret                  | Description                           |
| ----------------------- | ------------------------------------- |
| `AWS_ACCESS_KEY_ID`     | IAM user access key (CI/CD role)      |
| `AWS_SECRET_ACCESS_KEY` | IAM user secret key                   |
| `AWS_REGION`            | Target AWS region (e.g. `us-east-1`)  |
| `TF_STATE_BUCKET`       | S3 bucket name for Terraform state    |
| `TF_LOCK_TABLE`         | DynamoDB table name for state locking |
