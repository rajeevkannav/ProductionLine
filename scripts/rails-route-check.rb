# frozen_string_literal: true

# Fails when an application route points at a missing controller (Rails raises
# a 500-class routing error). Routes whose action is missing only 404, so they are
# reported as warnings (Rails' own generators emit e.g. resources :passwords with
# only new/create/edit/update implemented). Run inside the app:
#   bin/rails runner path/to/rails-route-check.rb
problems = []
warnings = []
Rails.application.reload_routes!
Rails.application.routes.routes.each do |route|
  controller = route.defaults[:controller]
  action = route.defaults[:action]
  next if controller.nil? || action.nil?
  next if controller.start_with?("rails/", "active_storage/", "action_mailbox/", "turbo/")

  klass = begin
    "#{controller.camelize}Controller".constantize
  rescue NameError
    problems << "#{route.verb} #{route.path.spec}: missing #{controller.camelize}Controller (app/controllers/#{controller}_controller.rb)"
    next
  end
  next if klass.action_methods.include?(action)
  next if klass.new.send(:template_exists?, action, klass.controller_path)

  warnings << "#{route.verb} #{route.path.spec}: #{klass} has no '#{action}' action (404)"
end

warn "[mogra] Route check warnings:\n  #{warnings.uniq.join("\n  ")}" if warnings.any?
if problems.any?
  warn "Routes without a controller:\n  #{problems.uniq.join("\n  ")}"
  exit 1
end
puts "[mogra] Route check: every route has a controller."
