# frozen_string_literal: true

# Production smoke check, run before merge against a throwaway database:
#   RAILS_ENV=production SECRET_KEY_BASE_DUMMY=1 bin/rails runner path/to/rails-production-smoke.rb
#
# Tests run in the test environment, so production-only configuration errors slip through
# (e.g. mail delivered over SMTP to localhost:25 on a host without a mail server, which turns
# every sign-up into a 500). This check boots the production configuration and:
#   1. fails when production mail would use SMTP without a real server address;
#   2. requests every parameterless GET route and fails on any 5xx response.
problems = []

if ActionMailer::Base.delivery_method == :smtp && ActionMailer::Base.perform_deliveries
  address = ActionMailer::Base.smtp_settings[:address].to_s
  if address.empty? || %w[localhost 127.0.0.1 ::1].include?(address)
    problems << "Production mail uses SMTP to '#{address.empty? ? 'localhost' : address}:#{ActionMailer::Base.smtp_settings[:port] || 25}', " \
                "which free hosts don't provide (every email send raises, e.g. sign-up returns 500). " \
                "Set config.action_mailer.delivery_method in config/environments/production.rb (e.g. :test until an HTTP email API is added)."
  end
end

Rails.application.reload_routes!
paths = Rails.application.routes.routes.filter_map do |route|
  next unless route.verb.to_s.split("|").include?("GET")
  next if route.defaults[:controller].nil? || route.defaults[:controller].start_with?("rails/", "active_storage/", "action_mailbox/", "turbo/")

  path = route.path.spec.to_s.sub("(.:format)", "")
  next if path.include?(":") || path.include?("*")

  path
end.uniq

session = ActionDispatch::Integration::Session.new(Rails.application)
session.host! "localhost"
session.https!
paths.each do |path|
  begin
    status = session.get(path)
  rescue StandardError => e
    problems << "GET #{path} raised #{e.class}: #{e.message.to_s[0, 200]}"
    next
  end
  problems << "GET #{path} returned #{status} in production" if status.to_i >= 500
end

if problems.any?
  warn "[mogra] Production smoke check failed:\n  #{problems.join("\n  ")}"
  $stderr.flush
  exit!(1) # plain exit inside `rails runner` is reported as an error with a confusing backtrace
end
puts "[mogra] Production smoke check passed (#{paths.size} GET routes, mail delivery: #{ActionMailer::Base.delivery_method})."
