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

---
session: 2026-05-17T23:55Z
duration_min: 35
issue: 3
focus: flake_reduction_patterns_retry_budget_wait_for_semantic_assert
delta:
  files_added: 6  # src/support/{retry-budget,wait-for,semantic-assert,index}.ts, test/support.test.ts, test/demo-flake-patterns.test.ts (+ docs/patterns.md)
  files_changed: 2  # src/index.ts, README.md
  tests_added: 25  # 24 unit + 1 demo
  test_pass_rate: "49/49 vitest + 3/3 playwright unchanged + 14/14 example-app unchanged"
context_for_next_session:
  - three_helpers_under_src_support_with_retry_budget_wait_for_expect_semantically_similar_all_dep_free
  - retry_budget_uses_caller_supplied_classify_callback_default_treats_network_families_plus_429_5xx_as_flake_d_009
  - retry_budget_backoff_multiplier_default_2_0_sleep_pluggable_onattempt_observer_for_diagnostics
  - wait_for_caps_final_sleep_to_remaining_budget_so_deadline_fires_on_time_sleep_and_now_injectable
  - semantic_assert_uses_jaccard_over_normalized_tokens_default_threshold_0_6_default_english_stopwords_pure_ts
  - composition_rule_documented_in_docs_patterns_md_retry_then_assert_then_wait
  - demo_test_in_test_demo_flake_patterns_test_ts_exercises_all_three_in_one_realistic_flow_flaky_503_paraphrased_response_delayed_ui_surface
  - public_surface_widened_root_index_re_exports_all_three_helpers_and_their_error_classes
  - vitest_total_49_passing_lint_clean_typecheck_clean
  - jaccard_calibration_section_in_docs_recommends_5_min_exercise_to_pick_threshold_per_workload
decisions_made: [D-009]
followups: []
---

---
session: 2026-05-18T04:10Z
duration_min: 25
issue: 5
focus: ci_under_5_minutes_caches_plus_timing_summary
delta:
  files_changed: 3
  tests_added: 0
context_for_next_session:
  - d_010_ci_caches_via_github_actions_builtins_only_no_third_party_tooling
  - example_app_npm_cache_was_missing_biggest_single_win
  - next_js_build_cache_keyed_on_lockfile_plus_source_hash_with_restore_keys_fallback
  - workflow_concurrency_group_cancels_stale_push_on_push_runs
  - per_job_timing_step_writes_step_summary_row_pw_job_includes_cache_hit_state
  - acceptance_5_consecutive_runs_under_5_min_is_post_merge_observable_pr_is_instrumentation_only
decisions_made: [D-010]
followups: []
---

---
session: 2026-05-18T23:30Z
duration_min: 20
issue: 11
focus: readme_truth_pass_drop_pending_4_framing_plus_count_drift_guard
delta:
  files_changed: 1   # README.md
  files_added: 1     # test/readme-snapshot.test.ts
  tests_added: 6
  test_pass_rate: "55/55"
  typecheck_pass: true
  lint_pass: true
  build_pass: true
context_for_next_session:
  - readme_what_this_is_section_rewritten_past_tense_describes_all_five_shipped_features
  - quickstart_hardcoded_24_tests_pass_comment_dropped_replaced_with_full_hermetic_vitest_suite_passes
  - demo_section_describes_today_two_command_runnable_demo_capture_filed_as_followup_12
  - new_test_readme_snapshot_test_ts_locks_referenced_files_exist_npm_run_resolves_no_bash_fence_hardcoded_test_count
  - drift_guard_specifically_rejects_pattern_n_tests_pass_inside_bash_fence_caught_the_drift_mode_this_pr_fixed
  - pattern_parallels_today_portfolio_wide_six_readme_hygiene_prs
decisions_made: []
followups: [#12]
---
