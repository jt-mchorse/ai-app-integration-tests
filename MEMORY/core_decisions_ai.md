# Core Decisions (AI-readable, YAML, append-only)
# Schema: see .skills/portfolio-memory/SKILL.md

- id: D-001
  date: 2026-05-10
  decision: scope_per_portfolio_handoff_section_2
  rationale: locked_scope_prevents_drift
  alternatives_rejected: []
  reversibility: expensive
  related_issues: []
  superseded_by: null

- id: D-002
  date: 2026-05-15
  decision: fetch_monkey_patch_for_interception_not_msw
  rationale: one_provider_anthropic_owning_300_lines_cheaper_than_msw_dep_plus_worker_node_split
  alternatives_rejected: [msw, nock, undici_mock_agent]
  reversibility: cheap
  related_issues: [#1, #2]
  superseded_by: null

- id: D-003
  date: 2026-05-15
  decision: cassette_hash_keyed_on_method_url_normalized_body_excluding_headers
  rationale: header_values_vary_across_runs_request_intent_lives_in_method_url_body
  alternatives_rejected: [include_headers_in_hash, hash_only_body, hash_full_serialized_request]
  reversibility: cheap
  related_issues: [#1]
  superseded_by: null

- id: D-004
  date: 2026-05-15
  decision: redaction_mandatory_runs_before_write_plus_ci_rescan
  rationale: leaked_credentials_must_never_reach_git_two_layer_check_belt_and_suspenders
  alternatives_rejected: [post_commit_scrub, manual_review_only, denylist_only_no_regex_scan]
  reversibility: cheap
  related_issues: [#1]
  superseded_by: null

- id: D-005
  date: 2026-05-15
  decision: missing_cassette_in_replay_mode_throws_no_silent_live_fallback
  rationale: silent_fallthrough_hides_credential_leaks_and_stale_tests
  alternatives_rejected: [silent_fallthrough_to_live, warn_and_fallthrough]
  reversibility: cheap
  related_issues: [#1]
  superseded_by: null
