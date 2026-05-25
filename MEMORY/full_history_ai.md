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

---
session: 2026-05-20T03:51Z
duration_min: 15
issue: 14
focus: ts_public_surface_pattern_third_typescript_variant_library_shape_with_exports_field
delta:
  files_added: 1   # test/public-surface.test.ts (vitest)
  files_changed: 0
  tests_added: 8   # 4 standalone, 1 of which is it.each over 5 README names
  test_pass_rate: "63/63"
  typecheck_pass: true
  lint_pass: true
context_for_next_session:
  - third_ts_variant_after_agent_orchestration_platform_pr_19_and_nextjs_streaming_pr_15
  - this_repo_is_library_shape_with_src_index_ts_aggregator_plus_dist_build_target_template_from_agent_orchestration_largely_copy_paste
  - swap_only_package_json_exports_dot_import_instead_of_bin_as_dist_source_of_truth
  - tamper_verified_three_axes_bad_version_drop_installfromenv_from_index_bad_exports_target
  - portfolio_wide_pattern_now_twelve_strikes_complete_across_all_python_and_ts_packages_in_portfolio_remaining_only_typescript_servers_in_mcp_cookbook_three_tsd_or_tsc_noemit_pattern_would_be_separate_effort
decisions_made: []
followups: []
---

---
session: 2026-05-21T23:23Z
duration_min: 25
issue: 12
focus: scripts_capture_demo_sh_three_surface_driver_plus_tsx_helper_plus_smoke_test_binary_deferred
delta:
  files_added: 3   # scripts/capture_demo.sh, scripts/missing_cassette_demo.ts, test/capture-demo-smoke.test.ts
  files_changed: 3 # README.md (Demo section), package.json (tsx devDep), eslint.config.js (scripts/**/*.ts)
  tests_added: 6
  test_pass_rate: "69/69"
  typecheck_pass: true
  lint_pass: true
context_for_next_session:
  - seventh_and_final_capture_demo_pattern_landed_across_portfolio_today_six_in_phase_a_merges_plus_nextjs_streaming_plus_this
  - tsx_added_as_devdep_so_capture_script_runs_typescript_helper_without_pre_built_dist_works_on_node_20_ci_and_node_25_local
  - eslint_config_extended_to_include_scripts_star_star_ts_so_the_helpers_type_assertion_parses_without_node_20_native_strip_types
  - surface_2_inline_tsx_helper_catches_real_missingcasseteerror_smoke_test_asserts_no_cassette_found_and_in_replay_mode_is_fatal_substrings_pinning_both_helper_and_error_message_text
  - surface_3_auto_skips_when_capture_skip_e2e_1_or_chromium_not_detected_so_toolkit_ci_job_runs_the_script_without_playwright_dep_dedicated_playwright_job_covers_e2e_path
  - smoke_test_uses_spawnsync_with_capture_pace_seconds_0_capture_skip_e2e_1_runs_in_1_6s_local_well_under_60s_ci_timeout
  - tamper_verified_surface_1_banner_change_fires_correct_assertion_reverted_clean
  - new_d_011_mirrors_d_012_in_nextjs_streaming_ai_patterns_and_equivalent_decisions_in_five_other_repos_that_landed_today
  - readme_snapshot_test_compatible_new_bash_fence_has_no_test_count_comment_new_npm_run_test_e2e_prefix_example_app_resolves_to_existing_script
  - portfolio_v01_engineering_quality_bar_essentially_complete_after_this_pr_only_remaining_open_issues_across_all_12_repos_are_priority_low_binary_recordings_followups_one_per_repo
decisions_made: [D-011]
followups: [#16]
---

---
session: 2026-05-22T17:45Z
duration_min: 30
issue: 18
focus: docs_architecture_md_reflects_shipped_playwright_and_flake_reduction_scope_not_substrate_only_state
delta:
  files_changed: 1   # docs/architecture.md
  files_added: 1     # test/architecture-doc.test.ts
  tests_added: 8
  test_pass_rate: "77/77 (was 69)"
  typecheck_pass: true
  lint_pass: true
context_for_next_session:
  - docs_architecture_md_was_committed_at_substrate_only_pr_and_never_reframed_when_playwright_2_and_flake_reduction_support_helpers_shipped
  - four_drift_sites_directory_diagram_listed_src_as_5_test_as_3_reality_6_and_8_l166_l167_said_playwright_is_2_scope_and_pr_ships_substrate_but_2_is_closed_and_e2e_streaming_spec_ts_exists_l169_l176_what_this_layer_is_not_said_not_a_playwright_test_runner_and_not_a_flake_reduction_library_both_shipped_l163_14_tests_count_comment_is_rot_prone
  - rewrote_directory_diagram_to_enumerate_src_support_all_8_test_files_example_app_e2e_and_scripts_replaced_playwright_substrate_paragraph_with_actual_shipped_split_replaced_what_this_layer_is_not_bullets_with_what_toolkit_genuinely_is_not_hosted_recording_service_generic_http_recorder_for_arbitrary_providers_replaced_14_tests_count_with_count_free_phrasing
  - new_architecture_doc_test_ts_five_invariants_path_tokens_resolve_four_banned_phrases_absent_banned_phrases_hard_pinned_doc_references_at_least_one_src_support_path_doc_references_at_least_one_example_app_e2e_path
  - tamper_verified_by_reintroducing_banned_section_4_of_8_new_tests_fired_naming_each_specific_phrase
  - thirteenth_post_v0_1_drift_fix_in_the_portfolio_pattern_fifth_in_this_session_third_architecture_doc_freeze_pattern_same_session_after_mcp_server_cookbook_22_and_nextjs_streaming_18
  - readme_already_correct_locked_by_existing_test_readme_snapshot_test_ts
decisions_made: []
followups: []
---

---
session: 2026-05-23T19:40Z
duration_min: 35
issue: 20
focus: architecture_doc_lock_active_decision_range_axis_plus_shipped_issue_axis_three_to_five_invariants_real_drift_backfill_four_d_nnns_three_hash_nns
delta:
  files_changed: 2   # docs/architecture.md, test/architecture-doc.test.ts
  tests_added: 4     # active-decision-coverage, shipped-issue-coverage, MIN hard-pin, KNOWN hard-pin
  tamper_verify_axes: 2
  test_pass_rate: "81/81 (was 77 in #18, gained 4 here)"
  drift_d_nnn_caught_and_fixed: [D-007, D-008, D-009, D-010]
  drift_hash_nn_caught_and_fixed: [1, 3, 5]
context_for_next_session:
  - active_decision_range_axis_pattern_now_at_12_of_12_repos_complete_portfolio_coverage_starting_with_llm_eval_harness_32_and_ending_with_ai_app_integration_tests_20_this_pr
  - shipped_issue_axis_now_in_two_repos_mcp_server_cookbook_26_and_ai_app_integration_tests_20_other_repos_use_alternative_lock_shapes_for_per_issue_coverage
  - real_drift_caught_first_run_d_007_d_008_d_009_d_010_missing_from_arch_doc_hash_1_hash_3_hash_5_missing_added_d_007_to_next_15_app_router_paragraph_d_008_to_playwright_paragraph_with_one_sentence_rationale_d_009_in_new_flake_reduction_helpers_section_d_010_in_new_ci_runtime_section_hash_1_added_to_opening_substrate_prose_hash_3_and_hash_5_in_new_sections
  - the_doc_grew_two_new_sections_flake_reduction_helpers_and_ci_runtime_each_about_one_paragraph_natural_fits_for_those_d_nnns_that_didnt_have_an_existing_section_to_amend_inline
  - bsd_sed_doesnt_support_b_word_boundary_used_explicit_hash_1_followed_by_non_digit_pattern_for_tamper_verify_caught_in_first_pass_when_sed_appeared_to_do_nothing
  - 4_new_invariants_added_to_what_was_an_8_test_file_now_12_tests_one_invariant_used_to_be_3_now_5_test_count_increase_4_due_to_2_axes_plus_2_hard_pins
  - portfolio_pattern_complete_active_decision_range_upper_bound_axis_at_12_of_12_repos
decisions_made: []
followups: []
---

---
session: 2026-05-24T15:50Z
duration_min: 10
issue: 22
focus: with_retry_budget_multiplier_validation_plus_x_goog_api_key_redaction
delta:
  files_changed: 4   # src/support/retry-budget.ts, src/cassette.ts, test/support.test.ts, test/cassette.test.ts
  files_added: 0
  tests_added: 3
  test_pass_rate: "84/84"
decisions_made: []
context_for_next_session:
  - with_retry_budget_validated_max_attempts_ge_1_and_backoff_ms_ge_0_but_not_backoff_multiplier_zero_multiplier_zeroes_exponential_negative_yields_nan_via_math_pow_into_sleep
  - guard_only_fires_when_value_is_supplied_undefined_still_falls_through_to_default_2_0_public_surface_unchanged_for_callers_without_the_field
  - sub_1_0_multiplier_is_valid_deliberate_decay_guard_is_gt_0_not_ge_1_0_explicit_test_pins_this
  - sensitive_header_names_was_missing_x_goog_api_key_canonical_for_google_gemini_vertex_ai_and_anthropic_via_vertex_sdk_flows
  - portfolio_pattern_eighth_in_day_session_loop_after_eval_harness_37_prompt_regression_32_mcp_cookbook_31_emb_shootout_26_async_pipelines_29_agent_orch_28_nextjs_23_second_ts_frontend_target_of_the_day
followups: []
---

---
session: 2026-05-25T04:50Z
duration_min: 30
issue: 24
focus: support_range_validators_extended_to_finiteness_nan_and_infinity_rejected
delta:
  files_changed: 4   # src/support/wait-for.ts, src/support/retry-budget.ts, src/support/semantic-assert.ts, test/support.test.ts
  files_added: 0
  tests_added: 19   # test/support.test.ts goes from 26 to 45; full suite 84 -> 103
  test_pass_rate: "103_passed"
decisions_made: []
context_for_next_session:
  - sign_only_range_checks_in_src_support_let_nan_and_infinity_through_three_callsites_silently_degraded_test_guarantees
  - worst_case_expectsemanticallysimilar_threshold_nan_silently_vacuous_assertion_always_passes_regardless_of_input_visible_only_when_a_real_regression_slips_through_review
  - waitfor_nan_polling_loop_never_times_out_all_comparisons_against_nan_false_infinity_settimeout_hangs_until_ci_outer_timeout
  - withretrybudget_nan_maxattempts_makes_loop_attempt_leq_nan_always_false_loop_never_runs_throws_retrybudgetexhaustederror_with_lasterror_undefined_fractional_maxattempts_silently_rounded
  - withretrybudget_nan_backoffms_or_backoffmultiplier_poisons_math_pow_into_nan_then_settimeout_nan_coerces_to_zero_silently_abandons_schedule
  - tightened_each_callsite_to_require_number_isfinite_plus_number_isinteger_for_maxattempts_error_messages_updated_to_must_be_a_finite_number_so_callers_can_grep_new_contract
  - tests_use_test_each_pattern_per_field_per_bad_value_table_plus_boundary_acceptance_regressions_file_uses_test_alias_not_it_kept_consistency
  - mirrors_portfolio_contract_tightening_sweep_eleven_sister_prs_landed_across_python_and_typescript_repos
  - fourth_typescript_repo_to_ship_pattern_follow_up_to_22_which_added_sign_only_validation_extending_to_finiteness
  - fifth_phase_bc_target_in_360_min_night_session_all_five_originally_unvisited_tonight_repos_now_have_a_phase_bc_pr
followups: []
---
