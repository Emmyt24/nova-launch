/**
 * Terraform IaC Configuration Tests
 *
 * Validates the structural integrity and security properties of the
 * Terraform configuration files without requiring a live AWS account.
 *
 * Tests cover:
 *  - Required files exist for all modules and environments
 *  - Sensitive variables are marked sensitive = true
 *  - No hardcoded secrets in .tf files
 *  - tfvars.example files use placeholder values
 *  - Module outputs are defined for all referenced values
 *  - Backend configuration is present in environment root modules
 *  - Required tags are applied to all environments
 *  - Security group rules follow least-privilege
 *  - Deletion protection is enabled in production
 *  - Encryption is enabled for RDS and ElastiCache
 *  - GitHub Actions workflow covers all environments
 *
 * Run: npx vitest run infra/terraform/tests/terraform-config.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "fs";
import * as path from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TERRAFORM_ROOT = path.resolve(__dirname, "..");

function tfRoot(...parts: string[]): string {
  return path.join(TERRAFORM_ROOT, ...parts);
}

function readFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function fileExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}

// ---------------------------------------------------------------------------
// Required file structure
// ---------------------------------------------------------------------------

describe("Required file structure", () => {
  const MODULES = [
    "networking",
    "ecr",
    "rds",
    "elasticache",
    "alb",
    "ecs",
    "secrets",
    "waf",
    "ecs-blue-green",
  ];

  const MODULE_FILES = ["main.tf", "variables.tf", "outputs.tf"];

  for (const mod of MODULES) {
    for (const file of MODULE_FILES) {
      it(`modules/${mod}/${file} exists`, () => {
        expect(fileExists(tfRoot("modules", mod, file))).toBe(true);
      });
    }
  }

  const ENVIRONMENTS = ["staging", "production"];
  const ENV_FILES = [
    "main.tf",
    "variables.tf",
    "outputs.tf",
    "terraform.tfvars.example",
  ];

  for (const env of ENVIRONMENTS) {
    for (const file of ENV_FILES) {
      it(`environments/${env}/${file} exists`, () => {
        expect(fileExists(tfRoot("environments", env, file))).toBe(true);
      });
    }
  }

  it("README.md exists", () => {
    expect(fileExists(tfRoot("README.md"))).toBe(true);
  });

  it("tests/validate.sh exists", () => {
    expect(fileExists(tfRoot("tests", "validate.sh"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sensitive variable declarations
// ---------------------------------------------------------------------------

describe("Sensitive variable declarations", () => {
  const SENSITIVE_VARS = [
    "jwt_secret",
    "admin_jwt_secret",
    "db_password",
    "ipfs_api_key",
    "ipfs_api_secret",
  ];

  /**
   * Checks that a variable block in a variables.tf file contains
   * `sensitive = true`.
   */
  function isSensitiveInFile(content: string, varName: string): boolean {
    // Match the variable block: variable "name" { ... }
    const blockRegex = new RegExp(
      `variable\\s+"${varName}"\\s*\\{[^}]*\\}`,
      "s",
    );
    const match = content.match(blockRegex);
    if (!match) return false;
    return /sensitive\s*=\s*true/.test(match[0]);
  }

  const variableFiles = [
    tfRoot("modules", "secrets", "variables.tf"),
    tfRoot("environments", "staging", "variables.tf"),
    tfRoot("environments", "production", "variables.tf"),
  ];

  for (const varName of SENSITIVE_VARS) {
    it(`'${varName}' is marked sensitive = true in at least one variables.tf`, () => {
      const foundSensitive = variableFiles.some((filePath) => {
        const content = readFile(filePath);
        if (!content) return false;
        return isSensitiveInFile(content, varName);
      });
      expect(
        foundSensitive,
        `Variable '${varName}' must have sensitive = true`,
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// No hardcoded secrets
// ---------------------------------------------------------------------------

describe("No hardcoded secrets in .tf files", () => {
  /**
   * Collects all .tf files recursively, excluding .terraform directories
   * and tfvars.example files.
   */
  function collectTfFiles(dir: string): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (
        entry.isDirectory() &&
        entry.name !== ".terraform" &&
        entry.name !== "node_modules"
      ) {
        results.push(...collectTfFiles(full));
      } else if (
        entry.isFile() &&
        entry.name.endsWith(".tf") &&
        !entry.name.includes("tfvars")
      ) {
        results.push(full);
      }
    }
    return results;
  }

  const SECRET_PATTERNS = [
    // Matches: password = "actualvalue123" (not in variable declarations)
    /(?<!variable\s+"\w+"\s*\{[^}]*)\bpassword\s*=\s*"[^"]{8,}"/,
    /(?<!variable\s+"\w+"\s*\{[^}]*)\bsecret\s*=\s*"[^"]{8,}"/,
    /(?<!variable\s+"\w+"\s*\{[^}]*)\bapi_key\s*=\s*"[^"]{8,}"/,
  ];

  const tfFiles = collectTfFiles(TERRAFORM_ROOT);

  it("found .tf files to check", () => {
    expect(tfFiles.length).toBeGreaterThan(0);
  });

  for (const pattern of SECRET_PATTERNS) {
    it(`no hardcoded values matching ${pattern}`, () => {
      const violations: string[] = [];
      for (const file of tfFiles) {
        const content = readFile(file);
        if (!content) continue;
        const lines = content.split("\n");
        lines.forEach((line, idx) => {
          // Skip variable declarations, descriptions, and comments
          if (
            line.trim().startsWith("#") ||
            line.trim().startsWith("//") ||
            line.includes("description") ||
            line.includes("variable ") ||
            line.includes("var.") ||
            line.includes("REPLACE_")
          )
            return;
          if (pattern.test(line)) {
            violations.push(
              `${path.relative(TERRAFORM_ROOT, file)}:${idx + 1}: ${line.trim()}`,
            );
          }
        });
      }
      expect(
        violations,
        `Hardcoded secrets found:\n${violations.join("\n")}`,
      ).toHaveLength(0);
    });
  }
});

// ---------------------------------------------------------------------------
// tfvars.example safety
// ---------------------------------------------------------------------------

describe("tfvars.example files use placeholder values", () => {
  const EXAMPLE_FILES = [
    tfRoot("environments", "staging", "terraform.tfvars.example"),
    tfRoot("environments", "production", "terraform.tfvars.example"),
  ];

  for (const exampleFile of EXAMPLE_FILES) {
    const label = path.relative(TERRAFORM_ROOT, exampleFile);

    it(`${label}: contains REPLACE_ placeholders for secrets`, () => {
      const content = readFile(exampleFile);
      expect(content).not.toBeNull();
      expect(content).toContain("REPLACE_");
    });

    it(`${label}: does not contain real-looking JWT secrets`, () => {
      const content = readFile(exampleFile);
      if (!content) return;
      // Real JWT secrets are typically 64+ random chars
      const realSecretPattern = /jwt_secret\s*=\s*"[a-zA-Z0-9+/]{64,}"/;
      expect(realSecretPattern.test(content)).toBe(false);
    });

    it(`${label}: does not contain real AWS account IDs (12 digits)`, () => {
      const content = readFile(exampleFile);
      if (!content) return;
      // Placeholder account ID is 123456789012
      const realAccountPattern =
        /aws_account_id\s*=\s*"(?!123456789012)\d{12}"/;
      expect(realAccountPattern.test(content)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// Backend configuration
// ---------------------------------------------------------------------------

describe("Backend configuration", () => {
  const ENVIRONMENTS = ["staging", "production"];

  for (const env of ENVIRONMENTS) {
    it(`${env}/main.tf has S3 backend configuration`, () => {
      const content = readFile(tfRoot("environments", env, "main.tf"));
      expect(content).not.toBeNull();
      expect(content).toContain('backend "s3"');
    });

    it(`${env}/main.tf references state key for ${env}`, () => {
      const content = readFile(tfRoot("environments", env, "main.tf"));
      expect(content).toContain(`${env}/terraform.tfstate`);
    });

    it(`${env}/main.tf has required_version >= 1.7.0`, () => {
      const content = readFile(tfRoot("environments", env, "main.tf"));
      expect(content).toMatch(/required_version\s*=\s*">= 1\.7\.0"/);
    });
  }
});

// ---------------------------------------------------------------------------
// Common tags
// ---------------------------------------------------------------------------

describe("Common tags applied to all environments", () => {
  const REQUIRED_TAG_KEYS = ["Project", "Environment", "ManagedBy"];

  const ENVIRONMENTS = ["staging", "production"];

  for (const env of ENVIRONMENTS) {
    it(`${env}/main.tf defines common_tags with required keys`, () => {
      const content = readFile(tfRoot("environments", env, "main.tf"));
      expect(content).not.toBeNull();
      for (const tag of REQUIRED_TAG_KEYS) {
        expect(content, `Missing tag key: ${tag}`).toContain(tag);
      }
    });

    it(`${env}/main.tf sets ManagedBy = terraform`, () => {
      const content = readFile(tfRoot("environments", env, "main.tf"));
      expect(content).toContain('ManagedBy   = "terraform"');
    });
  }
});

// ---------------------------------------------------------------------------
// Production-specific security settings
// ---------------------------------------------------------------------------

describe("Production security settings", () => {
  let prodMain: string | null;

  beforeAll(() => {
    prodMain = readFile(tfRoot("environments", "production", "main.tf"));
  });

  it("production uses multi-AZ NAT (single_nat_gateway = false)", () => {
    expect(prodMain).toContain("single_nat_gateway = false");
  });

  it("production uses multi-AZ RDS (multi_az = true)", () => {
    expect(prodMain).toContain("multi_az              = true");
  });

  it("production has deletion_protection = true for RDS", () => {
    expect(prodMain).toContain("deletion_protection   = true");
  });

  it("production has skip_final_snapshot = false", () => {
    expect(prodMain).toContain("skip_final_snapshot   = false");
  });

  it("production has longer log retention (90 days)", () => {
    expect(prodMain).toContain("log_retention_days = 90");
  });

  it("production has more backend replicas (desired_count = 2)", () => {
    expect(prodMain).toContain("backend_desired_count = 2");
  });

  it("production has higher backend_max_count for scaling", () => {
    expect(prodMain).toContain("backend_max_count     = 20");
  });
});

// ---------------------------------------------------------------------------
// Staging cost-saving settings
// ---------------------------------------------------------------------------

describe("Staging cost-saving settings", () => {
  let stagingMain: string | null;

  beforeAll(() => {
    stagingMain = readFile(tfRoot("environments", "staging", "main.tf"));
  });

  it("staging uses single NAT gateway (single_nat_gateway = true)", () => {
    expect(stagingMain).toContain("single_nat_gateway = true");
  });

  it("staging uses smaller RDS instance (db.t3.micro)", () => {
    expect(stagingMain).toContain('instance_class        = "db.t3.micro"');
  });

  it("staging has deletion_protection = false", () => {
    expect(stagingMain).toContain("deletion_protection     = false");
  });

  it("staging has skip_final_snapshot = true", () => {
    expect(stagingMain).toContain("skip_final_snapshot     = true");
  });
});

// ---------------------------------------------------------------------------
// Module security properties
// ---------------------------------------------------------------------------

describe("Module security properties", () => {
  describe("RDS module", () => {
    let rdsMain: string | null;

    beforeAll(() => {
      rdsMain = readFile(tfRoot("modules", "rds", "main.tf"));
    });

    it("storage_encrypted = true", () => {
      expect(rdsMain).toContain("storage_encrypted     = true");
    });

    it("publicly_accessible = false", () => {
      expect(rdsMain).toContain("publicly_accessible    = false");
    });

    it("enforces SSL via rds.force_ssl parameter", () => {
      expect(rdsMain).toContain("rds.force_ssl");
    });

    it("has enhanced monitoring enabled", () => {
      expect(rdsMain).toContain("monitoring_interval = 60");
    });

    it("has performance insights enabled", () => {
      expect(rdsMain).toContain("performance_insights_enabled          = true");
    });

    it("exports CloudWatch logs", () => {
      expect(rdsMain).toContain("enabled_cloudwatch_logs_exports");
    });

    it("has CPU alarm", () => {
      expect(rdsMain).toContain("rds-cpu-high");
    });

    it("has storage alarm", () => {
      expect(rdsMain).toContain("rds-storage-low");
    });
  });

  describe("ElastiCache module", () => {
    let cacheMain: string | null;

    beforeAll(() => {
      cacheMain = readFile(tfRoot("modules", "elasticache", "main.tf"));
    });

    it("at_rest_encryption_enabled = true", () => {
      expect(cacheMain).toContain("at_rest_encryption_enabled = true");
    });

    it("has memory alarm", () => {
      expect(cacheMain).toContain("redis-memory-high");
    });
  });

  describe("ALB module", () => {
    let albMain: string | null;

    beforeAll(() => {
      albMain = readFile(tfRoot("modules", "alb", "main.tf"));
    });

    it("uses TLS 1.3 / 1.2 security policy", () => {
      expect(albMain).toContain("ELBSecurityPolicy-TLS13-1-2-2021-06");
    });

    it("HTTP redirects to HTTPS (301)", () => {
      expect(albMain).toContain("HTTP_301");
    });

    it("drop_invalid_header_fields = true", () => {
      expect(albMain).toContain("drop_invalid_header_fields = true");
    });

    it("access logs enabled", () => {
      expect(albMain).toContain("access_logs");
      expect(albMain).toContain("enabled = true");
    });

    it("S3 bucket for logs has public access blocked", () => {
      expect(albMain).toContain("block_public_acls       = true");
      expect(albMain).toContain("block_public_policy     = true");
    });
  });

  describe("ECS module", () => {
    let ecsMain: string | null;

    beforeAll(() => {
      ecsMain = readFile(tfRoot("modules", "ecs", "main.tf"));
    });

    it("container insights enabled", () => {
      expect(ecsMain).toContain('"containerInsights"');
      expect(ecsMain).toContain('"enabled"');
    });

    it("secrets injected from Secrets Manager (not plaintext)", () => {
      expect(ecsMain).toContain("valueFrom");
      expect(ecsMain).toContain("jwt_secret_arn");
    });

    it("backend runs as non-root user (1001)", () => {
      expect(ecsMain).toContain('"1001"');
    });

    it("deployment circuit breaker with rollback enabled", () => {
      expect(ecsMain).toContain("deployment_circuit_breaker");
      expect(ecsMain).toContain("rollback = true");
    });

    it("auto-scaling policies defined", () => {
      expect(ecsMain).toContain("aws_appautoscaling_policy");
    });

    it("backend security group only allows traffic from ALB", () => {
      expect(ecsMain).toContain("alb_security_group_id");
      expect(ecsMain).toContain(
        "security_groups = [var.alb_security_group_id]",
      );
    });
  });

  describe("Networking module", () => {
    let netMain: string | null;
    let netVars: string | null;

    beforeAll(() => {
      netMain = readFile(tfRoot("modules", "networking", "main.tf"));
      netVars = readFile(tfRoot("modules", "networking", "variables.tf"));
    });

    it("VPC flow logs enabled", () => {
      expect(netMain).toContain("aws_flow_log");
    });

    it("flow logs capture ALL traffic", () => {
      expect(netMain).toContain('traffic_type    = "ALL"');
    });

    it("validates minimum 2 AZs", () => {
      expect(netVars).toContain("length(var.availability_zones) >= 2");
    });
  });

  describe("Secrets module", () => {
    let secretsMain: string | null;

    beforeAll(() => {
      secretsMain = readFile(tfRoot("modules", "secrets", "main.tf"));
    });

    it("creates JWT secret in Secrets Manager", () => {
      expect(secretsMain).toContain("aws_secretsmanager_secret");
      expect(secretsMain).toContain("jwt-secret");
    });

    it("creates DB password secret", () => {
      expect(secretsMain).toContain("db-password");
    });

    it("creates factory contract ID secret", () => {
      expect(secretsMain).toContain("factory-contract-id");
    });

    it("uses lifecycle ignore_changes to prevent overwriting rotated secrets", () => {
      expect(secretsMain).toContain("ignore_changes = [secret_string]");
    });
  });

  describe("WAF module", () => {
    let wafMain: string | null;

    beforeAll(() => {
      wafMain = readFile(tfRoot("modules", "waf", "main.tf"));
    });

    it("uses REGIONAL scope for ALB association", () => {
      expect(wafMain).toContain('scope       = "REGIONAL"');
    });

    it("includes AWSManagedRulesCommonRuleSet", () => {
      expect(wafMain).toContain('name        = "AWSManagedRulesCommonRuleSet"');
    });

    it("includes AWSManagedRulesKnownBadInputsRuleSet", () => {
      expect(wafMain).toContain('name        = "AWSManagedRulesKnownBadInputsRuleSet"');
    });

    it("includes AWSManagedRulesSQLiRuleSet", () => {
      expect(wafMain).toContain('name        = "AWSManagedRulesSQLiRuleSet"');
    });

    it("includes AWSManagedRulesAmazonIpReputationList", () => {
      expect(wafMain).toContain('name        = "AWSManagedRulesAmazonIpReputationList"');
    });

    it("redacts authorization header from WAF logs", () => {
      expect(wafMain).toContain('name = "authorization"');
    });

    it("redacts cookie header from WAF logs", () => {
      expect(wafMain).toContain('name = "cookie"');
    });

    it("rate-limit rule uses IP aggregate key", () => {
      expect(wafMain).toContain('aggregate_key_type = "IP"');
    });
  });

  describe("ECS blue-green module", () => {
    let ecsBgMain: string | null;

    beforeAll(() => {
      ecsBgMain = readFile(tfRoot("modules", "ecs-blue-green", "main.tf"));
    });

    it("backend container runs as non-root user 1001", () => {
      expect(ecsBgMain).toContain('user = "1001"');
    });

    it("blue service has deployment circuit breaker with rollback", () => {
      expect(ecsBgMain).toContain("deployment_circuit_breaker { enable = true; rollback = true }");
    });

    it("green service has deployment circuit breaker with rollback", () => {
      expect(ecsBgMain).toContain("deployment_circuit_breaker { enable = true; rollback = true }");
    });

    it("green slot starts with desired_count = 0", () => {
      expect(ecsBgMain).toContain("desired_count   = 0   # Inactive at creation; activated by deploy script");
    });
  });

  describe("ECR module", () => {
    let ecrMain: string | null;

    beforeAll(() => {
      ecrMain = readFile(tfRoot("modules", "ecr", "main.tf"));
    });

    it("scan_on_push = true for backend", () => {
      expect(ecrMain).toContain("scan_on_push = true");
    });

    it("encryption_type = AES256", () => {
      expect(ecrMain).toContain('encryption_type = "AES256"');
    });

    it("lifecycle policy removes untagged images", () => {
      expect(ecrMain).toContain("untagged");
      expect(ecrMain).toContain('"expire"');
    });
  });
});

// ---------------------------------------------------------------------------
// GitHub Actions Terraform workflow
// ---------------------------------------------------------------------------

describe("GitHub Actions Terraform workflow", () => {
  const workflowPath = path.resolve(
    __dirname,
    "../../../.github/workflows/terraform.yml",
  );
  let workflowContent: string | null;

  beforeAll(() => {
    workflowContent = readFile(workflowPath);
  });

  it("terraform.yml exists", () => {
    expect(workflowContent).not.toBeNull();
  });

  it("runs on push to main and develop", () => {
    expect(workflowContent).toContain("branches: [main, develop]");
  });

  it("has validate job", () => {
    expect(workflowContent).toContain("validate:");
  });

  it("has plan job for PRs", () => {
    expect(workflowContent).toContain("plan:");
  });

  it("has apply-staging job", () => {
    expect(workflowContent).toContain("apply-staging:");
  });

  it("has apply-production job with environment gate", () => {
    expect(workflowContent).toContain("apply-production:");
    expect(workflowContent).toContain("environment: production");
  });

  it("uses pinned Terraform version", () => {
    expect(workflowContent).toMatch(/TF_VERSION:\s*"1\.\d+\.\d+"/);
  });

  it("uses concurrency to prevent parallel runs", () => {
    expect(workflowContent).toContain("concurrency:");
    expect(workflowContent).toContain("cancel-in-progress: false");
  });

  it("posts plan diff as PR comment", () => {
    expect(workflowContent).toContain("Post Plan Comment");
  });

  it("uses -auto-approve only in apply jobs (not plan)", () => {
    const planSection =
      workflowContent?.match(/plan:\n[\s\S]*?(?=\n  \w)/)?.[0] ?? "";
    expect(planSection).not.toContain("-auto-approve");
  });
});

// ---------------------------------------------------------------------------
// Variable validation rules
// ---------------------------------------------------------------------------

describe("Variable validation rules", () => {
  it("networking module validates minimum 2 AZs", () => {
    const content = readFile(tfRoot("modules", "networking", "variables.tf"));
    expect(content).toContain("length(var.availability_zones) >= 2");
  });

  it("networking module validates environment values", () => {
    const content = readFile(tfRoot("modules", "networking", "variables.tf"));
    expect(content).toContain('contains(["staging", "production"]');
  });

  it("secrets module validates jwt_secret minimum length", () => {
    const content = readFile(tfRoot("modules", "secrets", "variables.tf"));
    expect(content).toContain("length(var.jwt_secret) >= 32");
  });

  it("secrets module validates db_password minimum length", () => {
    const content = readFile(tfRoot("modules", "secrets", "variables.tf"));
    expect(content).toContain("length(var.db_password) >= 16");
  });
});
