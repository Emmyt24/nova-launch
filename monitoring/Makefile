ALERTS_DIR := prometheus/alerts
ELK_DIR    := elk

.PHONY: test-alerts lint-alerts elk-bootstrap help

## test-alerts: validate all Prometheus alert rule files with promtool
test-alerts:
	@echo "==> Checking Prometheus alert rules..."
	@for f in $(ALERTS_DIR)/*.yml; do \
		echo "  promtool check rules $$f"; \
		promtool check rules "$$f" || exit 1; \
	done
	@echo "==> All alert rules OK"

## lint-alerts: alias for test-alerts
lint-alerts: test-alerts

## elk-bootstrap: register ILM policies with Elasticsearch (run once after startup)
elk-bootstrap:
	@echo "==> Registering ILM policies with Elasticsearch..."
	@if command -v curl >/dev/null 2>&1; then \
		curl -s -X PUT "http://localhost:9200/_ilm/policy/nova-launch-policy" \
			-H "Content-Type: application/json" \
			-d @$(ELK_DIR)/elasticsearch-ilm-policy.json || true; \
		curl -s -X PUT "http://localhost:9200/_ilm/policy/nova-security-policy" \
			-H "Content-Type: application/json" \
			-d @$(ELK_DIR)/elasticsearch-security-ilm-policy.json || true; \
		echo "==> ILM policies registered"; \
	else \
		echo "curl not found — manually PUT the JSON files to Elasticsearch _ilm/policy/ endpoints"; \
	fi

help:
	@grep -E '^## ' Makefile | sed 's/## //'
