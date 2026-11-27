# frozen_string_literal: true

# Fails when an application route points at a missing controller or action
# (no action method and no template for implicit rendering). Run inside the app:
#   bin/rails runner path/to/rails-route-check.rb
problems = []
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

  problems << "#{route.verb} #{route.path.spec}: #{klass} has no '#{action}' action or app/views/#{controller}/#{action} template"
end

if problems.any?
  warn "Routes without a controller action:\n  #{problems.uniq.join("\n  ")}"
  exit 1
end
puts "[mogra] Route check: every route has a controller action."
