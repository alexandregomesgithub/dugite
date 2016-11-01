import * as request from 'request'
import * as ProgressBar from 'progress'
import * as fs from 'fs'
import * as mkdirp from 'mkdirp'
import * as path from 'path'
import * as checksum from 'checksum'
import * as rimraf from 'rimraf'

const decompress = require('decompress')
const targz = require('tar.gz')

import { gitVersion, gitLfsVersion } from './versions'

export interface EnvironmentConfig {
  git: {
    version: string,
    fileName: string,
    source: string,
    checksum: string
  },
  lfs: {
    version: string,
    checksum: string,
    url: string,
    fileName: string
  },
  outputVersion: string
}

const verifyFile = (file: string, expected: string): Promise<boolean> => {
  return new Promise((resolve, reject) => {
    checksum.file(file, { algorithm: 'sha256' }, (_: any, hash: string) => {
      if (hash !== expected) {
        console.log(`checksum failed: got '${hash}' but expected '${expected}'`)
      }
      resolve(hash === expected)
    })
  })
}

const LFSAliases: { [key: string]: string | null } = {
  'win32': 'Windows AMD64',
  'darwin': 'Mac AMD64'
}

export class Config {
  public static async getConfig(platform: string): Promise<EnvironmentConfig | null> {

    const outputVersion = `${gitVersion}-1`
    const lfsPlatform = LFSAliases[platform] || undefined

    if (lfsPlatform === undefined) {
      return Promise.reject(`unable to resolve LFS platform for ${platform}`)
    }

    const foundGitLFS = await Downloader.resolveGitLFSForPlatform(gitLfsVersion, lfsPlatform)


    if (platform === 'darwin') {
      const fileName = `Git-macOS-${gitVersion}-64-bit.zip`
      return {
        git: {
          version: gitVersion,
          fileName: fileName,
          // NOTE: update these details if the place hosting the Git bits has changed
          source: `https://www.dropbox.com/s/w2l51jsibl90jtd/${fileName}?dl=1`,
          checksum: '5193a0923a7fc7cadc6d644d83bab184548987079f498cd77ee9df2a4509402e',
        },
        lfs: {
          version: gitLfsVersion,
          checksum: '66801312c377b77e31f39d28c61d74cd4731ad26a2cc6cf50dccf0acf0691d7c',
          url: foundGitLFS.url,
          fileName: foundGitLFS.fileName
        },
        outputVersion
      }
    } else if (platform === 'win32') {
      const upstreamVersion = `v${gitVersion}.windows.1`
      const fileName = `MinGit-${gitVersion}-64-bit.zip`
      return {
        git: {
          version: gitVersion,
          fileName: fileName,
          // NOTE: update these details if the place hosting the Git bits has changed
          source: `https://github.com/git-for-windows/git/releases/download/${upstreamVersion}/${fileName}`,
          checksum: 'a7268f4ab447e62940347d52fe01321403cfa3e9e94b8e5cac4d6ded28962d64',
        },
        lfs: {
          version: gitLfsVersion,
          checksum: 'cebbcd8f138834e0ba42f468dc8707845217524fb98fe16c7c06aa0afc984115',
          url: foundGitLFS.url,
          fileName: foundGitLFS.fileName
        },
        outputVersion
      }
    } else {
      return null
    }
  }
}

export class FileOperations {
  public static cleanupAll = (directory: string): Promise<void> => {

    if (!fs.existsSync(directory)) {
      return Promise.resolve()
    }

    return new Promise((resolve, reject) => {
      mkdirp(directory, (error: Error) => {
        if (error) {
          reject(error)
        }

        if (fs.existsSync(directory)) {
          try {
            rimraf.sync(directory)
          } catch (error) {
            reject(error)
          }
        }

        resolve()
      })
    })
  }
}

export class Archiver {
  public static extract = (source: string, destination: string, extension?: string): Promise<void> => {
    let options = {
        // strip any leading directory information
        strip: 1,
        // if a extension provided, let's filter on it
        filter: (file: { path: string} ) => extension === undefined
          ? true
          : path.extname(file.path) === extension
    }

    return decompress(source, destination, options)
  }

  public static unpackGitLFS = (platform: string, source: string, destination: string): Promise<void> => {
    if (platform === 'win32') {
      const nestedPath = path.join(destination, 'mingw64', 'libexec', 'git-core')
      return Archiver.extract(source, nestedPath, '.exe')
    } else if (platform === 'darwin') {
      const nestedPath = path.join(destination, 'libexec', 'git-core')
      return Archiver.extract(source, nestedPath, '')
    } else {
      return Promise.reject(`unable to unpack Git LFS as platform '${platform}' is not currently supported`)
    }
  }

  public static unpackGit = (source: string, directory: string): Promise<void> => {
    if (fs.existsSync(directory)) {
      rimraf.sync(directory)
    }

    return Archiver.extract(source, directory)
  }

  public static async unpackAll (platform: string, config: EnvironmentConfig, temporaryDirectory: string): Promise<void> {
    const temporaryGitDownload = path.join(temporaryDirectory, config.git.fileName)
    const temporaryGitDirectory = path.join(temporaryDirectory, platform, config.git.version)

    const temporaryGitLFSDownload =  path.join(temporaryDirectory, config.lfs.fileName)

    await Archiver.unpackGit(temporaryGitDownload, temporaryGitDirectory)
    await Archiver.unpackGitLFS(platform, temporaryGitLFSDownload, temporaryGitDirectory)
  }

  public static create = (directory: string, output: string): Promise<void> => {
    let read = targz().createReadStream(directory);
    let write = fs.createWriteStream(output);
    read.pipe(write);
    return Promise.resolve()
  }
}

export interface GitLFSLookup {
  url: string,
  fileName: string
}

export interface Asset {
  browser_download_url: string,
  name: string
}

export class Downloader {
  private static getReleaseAssets = (owner: string, repo: string, tag: string): Promise<ReadonlyArray<Asset>>=> {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${tag}`

    // TODO: look for environment variable for a GitHub token
    const options = {
      url: url,
      headers: {
        'User-Agent': 'git-kitchen-sink'
      }
    };

    return new Promise<ReadonlyArray<Asset>>((resolve, reject) => {
      request.get(options, (error, response, body) => {

        if (error) {
          reject(error)
        }

        if (response.statusCode === 403) {
          reject('Oops, it seems you\'ve been rate-limited on this IP address. Set GITHUB_API_TOKEN to an empty personal acceess token from https://github.com/settings/tokens to workaround this')
        }

        if (response.statusCode !== 200) {
          reject('unexpected response code: ' + response.statusCode)
        }

        const json = JSON.parse(body)
        resolve(json.assets)
      })
    })
  }

  public static resolveGitLFSForPlatform = async (version: string, platform: string): Promise<GitLFSLookup> => {

    const assets = await Downloader.getReleaseAssets('github', 'git-lfs', `v${version}`)

    const label = platform
    const asset = assets.find((a: any) => a.label === label)
    if (!asset) {
      return Promise.reject(`unable to find asset on Git-LFS release: ${label}`)
    }

    return Promise.resolve({ url: asset.browser_download_url, fileName: asset.name })
  }

  private static download = function (alias: string, url: string, destination: string): Promise<void> {
    return new Promise((resolve, reject) => {
      console.log(`Downloading ${url}`)

      const options = {
        url: url,
        headers: {
          'User-Agent': 'git-kitchen-sink'
        },
        encoding: null
      };

      const req = request.get(options, (error, response, body) => {

        // console.log(`Writing contents to ${url} to ${destination}`)

        const callback = (error?: Error) => {
          // TODO: i'm not sure if this is even valid
          if (error) {
            reject(error)
          }

          if (response.statusCode !== 200) {
            reject(`unexpected response code: ${response.statusCode}`)
          }

          resolve()
        }

        fs.createWriteStream(destination).write(body, callback)
      })

      req.on('response', function (res) {
        const len = parseInt(res.headers['content-length'], 10)

        console.log()
        const bar = new ProgressBar('Downloading ' + alias + ' [:bar] :percent :etas', {
          complete: '=',
          incomplete: ' ',
          width: 50,
          total: len
        })

        res.on('data', function (chunk) {
          bar.tick(chunk.length)
        })

        res.on('end', function () {
          console.log('\n')
        })
      })
    })
  }

  public static downloadGit = async (config: EnvironmentConfig, temporaryDirectory: string): Promise<void> => {

    const destination = path.join(temporaryDirectory, config.git.fileName)

    if (fs.existsSync(destination)) {
      const valid = await verifyFile(destination, config.git.checksum)
        if (valid) {
         return Promise.resolve()
      } else {
        console.log('cached Git found but doesn\'t match checksum, trying again...')
        rimraf.sync(destination)
        return Downloader.download('Git', config.git.source, destination)
      }
    } else {
      await Downloader.download('Git', config.git.source, destination)
      const isValid = await verifyFile(destination, config.git.checksum)
      if (!isValid) {
        rimraf.sync(destination)
        return Promise.reject('downloaded Git doesn\'t match checksum, aborting...')
      }
    }
  }

  public static downloadGitLFS = async (config: EnvironmentConfig, temporaryDirectory: string): Promise<void> => {

    const url = config.lfs.url
    const destination = path.join(temporaryDirectory, config.lfs.fileName)

    if (fs.existsSync(destination)) {
      const valid = await verifyFile(destination, config.lfs.checksum)
      if (valid) {
         return Promise.resolve()
      } else {
        console.log('cached Git LFS found but doesn\'t match checksum, trying again...')
        rimraf.sync(destination)
        return Downloader.download('Git LFS', url, destination)
      }
    } else {
      await Downloader.download('Git LFS', url, destination)
      const valid = await verifyFile(destination, config.lfs.checksum)

      if (valid) {
        return Promise.resolve()
      } else {
        rimraf.sync(destination)
        return Promise.reject('downloaded Git LFS doesn\'t match checksum, aborting...')
      }
    }
  }
}
