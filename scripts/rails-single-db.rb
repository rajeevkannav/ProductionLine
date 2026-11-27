# frozen_string_literal: true

# Convert a Rails 8 app from four production databases (primary, cache, queue,
# cable) to one, for hosts that provide a single DATABASE_URL (e.g. Render free
# Postgres, Neon). Follows the Solid Queue/Cache/Cable single-database setup: the
# Solid schemas become a regular migration and the separate connections are
# removed. Idempotent.
#
# Usage: ruby rails-single-db.rb <rails-app-dir>

require "fileutils"

root = File.expand_path(ARGV.fetch(0, "."))
Dir.chdir(root)

def rewrite(path)
  return unless File.exist?(path)

  before = File.read(path)
  after = yield(before.dup)
  File.write(path, after) if after != before
end

# 1. database.yml: production keeps only the primary config (DATABASE_URL merges into it).
rewrite("config/database.yml") do |yml|
  head = yml.split(/^production:\s*$/).first
  head.rstrip + "\n\n" + <<~YAML
    production:
      <<: *default
      url: <%= ENV["DATABASE_URL"] %>
  YAML
end

# 2. Solid Queue / Cache / Cable use the primary connection.
rewrite("config/environments/production.rb") do |rb|
  rb.gsub(/^\s*config\.solid_queue\.connects_to\s*=.*\n/, "")
end
rewrite("config/cache.yml") do |yml|
  yml.gsub(/^(\s*)database:\s*cache\s*\n/, "")
end
rewrite("config/cable.yml") do |yml|
  yml.gsub(/^(\s*)connects_to:\s*\n\s*database:\s*\n\s*writing:\s*cable\s*\n/, "")
end

# 3. Solid schemas -> one migration on the primary database.
schemas = %w[cache queue cable].map { |n| "db/#{n}_schema.rb" }.select { |f| File.exist?(f) }
unless schemas.empty? || Dir.glob("db/migrate/*_create_solid_tables.rb").any?
  body = schemas.map do |file|
    src = File.read(file)
    inner = src[/\.define\(version:[^)]*\)\s*do\s*\n(.*)\nend\s*\z/m, 1] or abort("cannot parse #{file}")
    inner.gsub(/,\s*force:\s*:cascade/, "")
  end.join("\n\n")

  FileUtils.mkdir_p("db/migrate")
  File.write("db/migrate/20250101000000_create_solid_tables.rb", <<~RUBY)
    # Solid Cache, Queue, and Cable tables on the primary database (single-database setup).
    class CreateSolidTables < ActiveRecord::Migration[8.0]
      def change
    #{body.lines.map { |l| l.strip.empty? ? "\n" : "  #{l}" }.join}
      end
    end
  RUBY
  schemas.each { |f| File.delete(f) }
  FileUtils.rm_rf(%w[db/cache_migrate db/queue_migrate db/cable_migrate])
end

puts "[mogra] Converted to a single production database (Solid tables via db/migrate)."
