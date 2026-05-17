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

- id: D-006
  date: 2026-05-16
  decision: example_app_is_peer_subproject_not_root_dep
  rationale: toolkit_runtime_stays_dep_clean_next_js_only_loads_when_someone_runs_example_app_dev
  alternatives_rejected: [hoist_nextjs_into_root_devdeps, monorepo_workspaces_more_overhead_than_value_for_one_subproject, vendor_into_root_src]
  reversibility: cheap
  related_issues: [#4, #2]
  superseded_by: null

- id: D-007
  date: 2026-05-16
  decision: example_app_uses_next_15_app_router_not_pages
  rationale: aligns_with_nextjs_streaming_ai_patterns_recommended_path_react_19_server_actions_available_for_future
  alternatives_rejected: [pages_router_legacy, remix_off_stack, vite_ssr_diverges_from_repo_stack]
  reversibility: cheap
  related_issues: [#4]
  superseded_by: null

- id: D-008
  date: 2026-05-16
  decision: playwright_anthropic_stub_via_next_instrumentation_hook_not_toolkit_cassette_layer
  rationale: hash_matching_against_sdk_request_body_for_hand_authored_cassettes_is_finicky_and_drifts_on_sdk_upgrades_prompt_keyword_stub_is_simpler_for_three_deterministic_streams
  alternatives_rejected: [cassette_layer_with_hand_authored_cassettes, msw_or_other_third_party_mock_at_browser_layer, real_anthropic_in_ci_with_api_key]
  reversibility: cheap
  related_issues: [#2]
  superseded_by: null

- id: D-009
  date: 2026-05-17
  decision: flake_classification_is_caller_supplied_classify_callback_not_thrown_class_hierarchy_default_classifier_treats_network_families_plus_429_5xx_as_flake_everything_else_hard
  rationale: callers_have_different_conventions_for_what_counts_as_flake_in_their_stack_classify_callback_pushes_decision_to_callsite_where_context_is_visible_default_handles_the_universal_network_cases_so_simple_callers_dont_have_to_configure_mirrors_single_method_protocol_pattern_in_the_rest_of_the_portfolio_eg_d_005_d_008_in_other_repos
  alternatives_rejected: [thrown_class_hierarchy_with_flake_marker_requires_callers_to_wrap_third_party_errors, hardcoded_classifier_in_helper_loses_per_callsite_context, no_default_classifier_forces_every_caller_to_configure_even_for_the_universal_network_cases]
  reversibility: cheap
  related_issues: [3]
  superseded_by: null
