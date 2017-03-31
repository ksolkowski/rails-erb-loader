var exec = require('child_process').exec
var path = require('path')
var getOptions = require('loader-utils').getOptions
var defaults = require('lodash.defaults')
var util = require('util')

function pushAll (dest, src) {
  Array.prototype.push.apply(dest, src)
}

/* Create a delimeter that is unlikely to appear in parsed code. I've split this
 * string deliberately in case this file accidentally ends up being transpiled
 */
var ioDelimiter = '_' + '_RAILS_ERB_LOADER_DELIMETER__'

/* Match any block comments that start with the string `rails-erb-loader-*`. */
var configCommentRegex = /\/\*\s*rails-erb-loader-([a-z-]*)\s*([\s\S]*?)\s*\*\//g

/* Match any path ending with a file extension */
var fileExtensionRegex = /\.\w*$/

/* Takes a path and attaches `.rb` if it does not already have an extension. */
function defaultFileExtension (dependency) {
  return fileExtensionRegex.test(dependency) ? dependency : dependency + '.rb'
}

/* Get each space separated path, ignoring any empty strings. */
function parseDependencies (root, string) {
  return string.split(/\s+/).reduce(function (accumulator, dependency) {
    if (dependency.length > 0) {
      var absolutePath = path.resolve(root, defaultFileExtension(dependency))
      accumulator.push(absolutePath)
    }
    return accumulator
  }, [])
}

/* Update config object in place with comments from file */
function parseComments (source, config) {
  var match = null
  while ((match = configCommentRegex.exec(source))) {
    var option = match[1]
    var value = match[2]
    switch (option) {
      case 'dependency':
      case 'dependencies':
        var dependencies = parseDependencies(config.dependenciesRoot, value)
        pushAll(config.dependencies, dependencies)
        break
      case 'dependencies-root':
        config.dependenciesRoot = value
        break
      default:
        console.warn(
          'WARNING: Unrecognized configuration command ' +
          '"rails-erb-loader-' + option + '". Comment ignored.'
        )
    }
  }
}

/* Launch Rails in a child process and run the `erb_transformer.rb` script to
 * output transformed source.
 */
function transformSource (runner, engine, source, map, callback) {
  var child = exec(
    runner + ' ' + path.join(__dirname, 'erb_transformer.rb') + ' ' + ioDelimiter + ' ' + engine,
    function (error, stdout) {
      // Output is delimited to filter out unwanted warnings or other output
      // that we don't want in our files.
      var sourceRegex = new RegExp(ioDelimiter + '([\\s\\S]+)' + ioDelimiter)
      var matches = stdout.match(sourceRegex)
      var transformedSource = matches && matches[1]
      callback(error, transformedSource, map)
    }
  )
  child.stdin.on('error', function (error) {
    if (error.code === 'EPIPE') {
      // When the `runner` command is not found, stdin will not be open.
      // Attemping to write then causes an EPIPE error. Ignore this because the
      // `exec` callback gives a more meaningful error that we show to the user.
    } else {
      console.error(
        'rails-erb-loader encountered an unexpected error while writing to stdin: "' +
        error.message + '". Please report this to the maintainers.'
      )
    }
  })
  child.stdin.write(source)
  child.stdin.end()
}

function setRailsRunner (config) {
  config.runner = config.rails + ' runner'
}

var deprecatedSetRailsRunner = util.deprecate(setRailsRunner,
  'The rails-erb-loader config option `rails` is deprecated. ' +
  'Please use `runner` instead.'
)

module.exports = function railsErbLoader (source, map) {
  var loader = this

  // Mark loader cacheable. Must be called explicitly in webpack 1.
  // see: https://webpack.js.org/guides/migrating/#cacheable
  loader.cacheable()

  // Get options passed in the loader query, or use defaults.
  // Modifying the return value of `getOptions` is not permitted.
  var config = defaults({}, getOptions(loader), {
    dependencies: [],
    dependenciesRoot: 'app',
    parseComments: true,
    runner: './bin/rails runner',
    engine: 'erubis'
  })

  // Handle `rails` config option. This is the path to the rails binary.
  if ('rails' in config) {
    deprecatedSetRailsRunner(config)
  }

  // loader-utils does not support parsing arrays, so we might have to do it
  // ourselves.
  if (typeof config.dependencies === 'string') {
    config.dependencies = parseDependencies(
      config.dependenciesRoot,
      config.dependencies
    )
  }

  // Update `config` object in place with any parsed comments.
  if (config.parseComments) {
    parseComments(source, config)
  }

  // Register watchers for any dependencies.
  config.dependencies.forEach(function (dependency) {
    loader.addDependency(dependency)
  })

  // Now actually transform the source.
  var callback = loader.async()
  transformSource(config.runner, config.engine, source, map, callback)
}
