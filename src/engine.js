const EventEmitter = require('events')
const readline = require('./readline')
const {Command, Response} = require('./main')

module.exports = class Engine extends EventEmitter {
    constructor(name = '', version = '') {
        super()

        this.handlers = {
            'protocol_version': '2',
            'name': name,
            'version': version,
            'known_command': ({args}, out) => out.send(`${args[0] in this.handlers}`),
            'list_commands': (_, out) => out.send(Object.keys(this.handlers).join('\n')),
            'quit': (_, out) => (out.end(), process.exit())
        }

        this.commands = []
        this.busy = false
    }

    command(name, handler) {
        this.handlers[name] = handler
    }

    async _processCommands({output}) {
        if (this.commands.length === 0 || this.busy) return

        let command = this.commands.shift()
        this.busy = true

        this.emit('command-processing', {command})

        if (!(command.name in this.handlers)) {
            output.write(Response.toString({
                id: command.id,
                error: true,
                content: 'unknown command'
            }))
            output.write('\n\n')

            this.busy = false
            return
        }

        let handler = this.handlers[command.name]
        let response = {id: command.id, content: ''}

        if (typeof handler !== 'function') {
            let content = handler ? handler.toString() : ''
            handler = (_, {send}) => send(content)
        }

        let notWritten = true
        let write = await new Promise(resolve => {
            let ended = false
            let end = () => {
                if (ended) return
                if (notWritten) {
                    output.write(Response.toString(response) + ' ')
                    notWritten = false
                }

                ended = true
                output.write('\n\n')
                resolve(false)
            }

            let result = handler(command, {
                write(content) {
                    if (notWritten) {
                        output.write(Response.toString(response) + ' ')
                        notWritten = false
                    }

                    response.content += content
                    output.write(content)
                },
                end,
                err(content) {
                    response.content = content
                    response.error = true
                    ended = true
                    resolve(true)
                },
                send(content) {
                    response.content = content
                    ended = true
                    resolve(true)
                }
            })

            if (result instanceof Promise) {
                result.then(end)
            }
        }).catch(err => {
            console.error(err)

            response.content = 'internal error'
            response.error = true
            return true
        })

        if (write) {
            output.write(Response.toString(response))
            output.write('\n\n')
        }

        this.emit('command-processed', {command, response})

        this.busy = false
        await this._processCommands({output})
    }

    start({input = null, output = null} = {}) {
        if (typeof process !== 'undefined') {
            if (input == null) input = process.stdin
            if (output == null) output = process.stdout
        }

        this._lineReader = readline.createInterface({input, output, prompt: ''})

        this._lineReader.on('line', line => {
            line = line.replace(/#.*?$/, '').trim()

            if (line.trim() === '') return

            let command = Command.fromString(line)
            this.commands.push(command)

            this.emit('command-received', {command})
            this._processCommands({output})
        })

        this._lineReader.prompt()
    }

    stop() {
        this._lineReader.close()
    }
}
