require 'json'

package = JSON.parse(File.read(File.join(__dir__, 'package.json')))

# Load the spm_dependency helper from React Native (available in RN 0.76+)
react_native_path = File.join(
  File.dirname(`node --print "require.resolve('react-native/package.json')"`),
  "scripts/react_native_pods"
)
require react_native_path

Pod::Spec.new do |s|
  s.name           = 'AgentNative'
  s.version        = package['version']
  s.summary        = package['description']
  s.description    = package['description']
  s.license        = package['license']
  s.author         = '.'
  s.homepage       = 'https://www.trymantra.ai'
  s.source         = { :path => '.' }
  s.platforms      = { :ios => '16.0' }
  s.swift_version  = '5.4'
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Meta Wearables DAT SDK via Swift Package Manager
  spm_dependency(s,
    url: 'https://github.com/facebook/meta-wearables-dat-ios',
    requirement: { kind: 'exactVersion', version: '0.7.0' },
    products: ['MWDATCore', 'MWDATCamera', 'MWDATDisplay']
  )

  s.source_files = 'ios/**/*.{h,m,swift}'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
