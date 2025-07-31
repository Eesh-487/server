-- Migration to fix ON CONFLICT and integer overflow errors for market_data
ALTER TABLE market_data ADD CONSTRAINT market_data_symbol_unique UNIQUE (symbol);
ALTER TABLE market_data ALTER COLUMN volume TYPE BIGINT;
ALTER TABLE market_data ALTER COLUMN market_cap TYPE BIGINT;
