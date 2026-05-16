# Session History (AI-readable, append-only)

Schema: see .skills/portfolio-memory/SKILL.md

---
session: 2026-05-15T11:07Z
duration_min: 60
issue: 1
focus: deterministic_anthropic_api_replay_via_fetch_monkey_patch
delta:
  files_added: 13
  files_changed: 3
  tests_added: 24
  test_pass_rate: "24/24"
  fixtures_committed: 1
context_for_next_session:
  - replay_layer_shipped_install_from_env_record_replay_live
  - cassette_format_v1_locked_in_src_cassette_ts
  - redaction_two_layer_header_denylist_plus_body_regex_scan_d_004
  - ci_no_leaked_secrets_job_rescans_committed_cassettes
  - playwright_layer_2_must_call_install_from_env_in_global_setup
decisions_made: [D-002, D-003, D-004, D-005]
followups: []
---

---
session: 2026-05-16T03:46Z
duration_min: 55
issue: 4
focus: example_nextjs_15_app_three_llm_screens_streaming_tools_error
delta:
  files_added: 18
  files_changed: 4
  tests_added: 14
  test_pass_rate: "14/14 example-app + 24/24 toolkit unchanged"
context_for_next_session:
  - example_app_in_example_app_subdir_peer_subproject_d_006_own_package_json_node_modules
  - app_router_next_15_react_19_anthropic_sdk_d_007
  - three_routes_streaming_sse_text_deltas_tools_two_tool_loop_error_three_failure_kinds
  - route_handlers_exported_functions_tests_call_with_request_directly_no_server_needed
  - streaming_route_test_monkeypatches_fetch_with_canned_anthropic_sse_frames
  - tools_route_test_sequences_two_canned_responses_turn_1_tool_use_turn_2_final_text
  - error_route_test_validation_and_shape_paths_no_anthropic_call_at_all
  - root_scripts_example_install_dev_build_test_test_all_proxy_into_subproject
  - ci_new_example_app_job_npm_install_then_build_then_test_parallel_to_toolkit
  - issue_4_acceptance_app_boots_with_npm_run_dev_three_llm_driven_screens_used_by_all_tests_in_repo_done
  - issue_2_now_unblocked_playwright_can_run_against_localhost_3000
  - selection_rule_deviation_picked_4_over_strictly_lower_2_documented_in_plan_comment
decisions_made: [D-006, D-007]
followups: []
---


---
session: 2026-05-16T15:37Z
duration_min: 45
issue: 2
focus: playwright_streaming_ui_tests_with_nextjs_instrumentation_stub
delta:
  files_added: 4  # instrumentation.ts, instrumentation-stub.ts, playwright.config.ts, e2e/streaming.spec.ts
  files_changed: 4  # ci.yml, README, example-app package.json/lock, example-app .gitignore
  tests_added: 3
  test_pass_rate: "3/3 playwright + 24/24 root vitest + 14/14 example-app vitest"
  benchmarks:
    playwright_total_seconds: 4.5
    short_stream_ms: 962
    long_stream_ms: 1000
    error_stream_ms: 175
context_for_next_session:
  - nextjs_instrumentation_ts_installs_fetch_interceptor_when_anthropic_test_mode_replay
  - stub_routes_by_prompt_keyword_short_error_default_long
  - playwright_chromium_only_singleworker_15s_timeout_traces_on_failure
  - ci_caches_ms_playwright_dir_keyed_on_playwright_version
  - d_008_records_decision_to_use_instrumentation_stub_not_cassette_layer_for_this_issue
  - cassette_layer_remains_available_for_future_playwright_issues_that_need_recorded_conversations
decisions_made: [D-008]
followups: []
---
