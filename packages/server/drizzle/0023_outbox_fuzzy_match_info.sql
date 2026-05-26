-- Add fuzzy_match_info to outbox to record when patch_file search strings were
-- resolved via fuzzy matching rather than exact matching. Stores a JSON array
-- describing which edits were fuzzily resolved and what the actual matched text was.
ALTER TABLE `outbox` ADD `fuzzy_match_info` text;
