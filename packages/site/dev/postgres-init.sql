-- The image creates sessiongraph_dev from POSTGRES_DB before running this file.
-- API tests reset their tables, so they use a separate database.
CREATE DATABASE sessiongraph_test OWNER sessiongraph;
